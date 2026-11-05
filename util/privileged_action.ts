import type {
  BuildkitePipeline,
  CommandStep,
  GroupStep,
  Step,
} from "~/builder/pipeline.ts"
import type { Env } from "~/util/env.ts"
import { isTrustedReleaseContext } from "~/util/trusted_context.ts"

const SECRET_REQUIRED_ACTIONS = new Set([
  "divvun-keyboard-ios",
  "divvun-keyboard-android",
  "divvun-keyboard-windows",
  "divvun-keyboard-windows-v4",
  "divvun-keyboard-macos",
  "donate-speech-build-ios",
  "donate-speech-build-android",
  "subethaedit-build-macos",
  "libreoffice-extension-build-oxt-macos",
  "libreoffice-extension-build-oxt-linux",
  "libreoffice-extension-build-oxt-windows",
  "libreoffice-extension-installer-macos",
  "libreoffice-extension-installer-windows",
])

export function isPrivilegedPipelineAction(
  action: string,
  args: readonly string[] = [],
): boolean {
  if (
    action === "macos-sign" ||
    action.endsWith("-bump-manifest") ||
    /(?:^|-)(?:deploy|publish)(?:-|$)/.test(action) ||
    SECRET_REQUIRED_ACTIONS.has(action)
  ) {
    return true
  }

  return action === "divvun-actions-build-image" && args.includes("push")
}

export function commandRequiresTrustedContext(command: string): boolean {
  if (/\bdivvun-actions(?:\.bat)?\s+sign(?:\s|$)/.test(command)) {
    return true
  }

  const match = command.match(
    /\bdivvun-actions(?:\.bat)?\s+run\s+([^\s"']+)(.*)$/,
  )
  if (!match) return false

  return isPrivilegedPipelineAction(
    match[1],
    match[2].trim().split(/\s+/).filter(Boolean),
  )
}

type DependsOn = CommandStep["depends_on"]
type Dependency = string | { step: string; allow_failure?: boolean }

function collectRemovedDependencies(
  steps: Step[],
  removed: Map<string, DependsOn>,
): void {
  for (const step of steps) {
    if ("group" in step) {
      collectRemovedDependencies(step.steps, removed)
    } else if (
      "command" in step && step.key && step.command != null &&
      (typeof step.command === "string" ? [step.command] : step.command).some(
        commandRequiresTrustedContext,
      )
    ) {
      removed.set(step.key, step.depends_on)
    }
  }
}

function rewriteDependencies(
  dependsOn: DependsOn,
  removed: Map<string, DependsOn>,
): DependsOn {
  if (dependsOn == null) return dependsOn

  const input = Array.isArray(dependsOn) ? dependsOn : [dependsOn]
  const output: Dependency[] = []
  for (const dependency of input) {
    const key = typeof dependency === "string" ? dependency : dependency.step
    const replacement = removed.get(key)
    if (!removed.has(key)) {
      output.push(dependency)
      continue
    }

    const rewritten = rewriteDependencies(replacement, removed)
    if (rewritten == null) continue
    output.push(...(Array.isArray(rewritten) ? rewritten : [rewritten]))
  }

  if (output.length === 0) return undefined
  return output.length === 1 && typeof output[0] === "string"
    ? output[0]
    : output
}

function secureStep(
  step: Step,
  removed: Map<string, DependsOn>,
): Step | null {
  if ("group" in step) {
    const steps = step.steps.map((child) => secureStep(child, removed)).filter(
      (value): value is Step => value != null,
    )
    if (steps.length === 0) return null
    const secured: GroupStep = {
      ...step,
      steps,
    }
    const dependsOn = rewriteDependencies(step.depends_on, removed)
    if (dependsOn == null) delete secured.depends_on
    else secured.depends_on = dependsOn
    return secured
  }

  if ("command" in step) {
    const command = step.command
    const commands = typeof command === "string" ? [command] : command ?? []
    if (commands.some(commandRequiresTrustedContext)) return null
    const secured: CommandStep = {
      ...step,
    }
    const dependsOn = rewriteDependencies(step.depends_on, removed)
    if (dependsOn == null) delete secured.depends_on
    else secured.depends_on = dependsOn
    return secured
  }

  const secured = { ...step }
  const dependsOn = rewriteDependencies(step.depends_on, removed)
  if (dependsOn == null) delete secured.depends_on
  else secured.depends_on = dependsOn
  return secured
}

/**
 * Defense in depth for pipeline generation. Untrusted builds keep their
 * secret-free build and test steps, while privileged and credential-dependent
 * steps are omitted before the YAML reaches Buildkite.
 */
export function securePipelineForContext(
  pipeline: BuildkitePipeline,
  env: Pick<
    Env,
    "branch" | "tag" | "pullRequest" | "repoHost" | "repoPath"
  >,
): BuildkitePipeline {
  if (isTrustedReleaseContext(env)) return pipeline

  const removed = new Map<string, DependsOn>()
  collectRemovedDependencies(pipeline.steps, removed)
  const steps = pipeline.steps.map((step) => secureStep(step, removed)).filter(
    (value): value is Step => value != null,
  )

  return {
    ...pipeline,
    steps: steps.length > 0 ? steps : [{
      label: "Privileged packaging skipped",
      command:
        "echo 'No secret-free build or test steps are defined for this context'",
      agents: { queue: "linux" },
    }],
  }
}
