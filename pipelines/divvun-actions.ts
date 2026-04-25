import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"

type TargetSpec = {
  target: string
  /** Buildkite agent queue to schedule the build on. */
  queue: "linux" | "windows"
  /**
   * If set, this target's `docker build` won't start until the named target's
   * build+push completes (used for `windows` depending on `windows-vsbase`).
   */
  dependsOn?: string
  /**
   * Pass `--platform <plat>` to docker build. Omit on windows since the
   * Windows daemon only knows windows containers.
   */
  platform?: string
}

const TARGET_SPECS: TargetSpec[] = [
  { target: "alpine", queue: "linux", platform: "linux/amd64" },
  { target: "linux", queue: "linux", platform: "linux/amd64" },
  { target: "windows-vsbase", queue: "windows" },
  { target: "windows", queue: "windows", dependsOn: "build-windows-vsbase" },
]
const VALID_TARGETS = TARGET_SPECS.map((s) => s.target)

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineDivvunActions(): BuildkitePipeline {
  const isMain = builder.env.branch === "main"

  const steps: BuildkitePipeline["steps"] = [
    command({
      key: "drift-check",
      label: ":mag: Dockerfile drift check",
      command: ["deno task docker:check"],
      agents: { queue: "linux" },
    }),
    { wait: null },
  ]

  for (const spec of TARGET_SPECS) {
    const dependsOn = spec.dependsOn
      ? [spec.dependsOn]
      : ["drift-check"]
    steps.push(
      command({
        key: `build-${spec.target}`,
        label: `:whale: Build ${spec.target}`,
        command: [
          `divvun-actions run divvun-actions-build-image ${spec.target} ${
            isMain ? "push" : "no-push"
          }`,
        ],
        agents: { queue: spec.queue },
        depends_on: dependsOn,
      }),
    )
  }

  return { steps }
}

export async function runDivvunActionsBuildImage(
  target: string,
  pushArg: string,
) {
  const spec = TARGET_SPECS.find((s) => s.target === target)
  if (!spec) {
    throw new Error(
      `Unknown target: ${target}. Expected one of: ${VALID_TARGETS.join(", ")}`,
    )
  }
  const shouldPush = pushArg === "push"

  // Regenerate first; the upstream drift check guarantees no real changes,
  // but doing this here keeps the build hermetic if anyone runs the action
  // directly off the CI path.
  await builder.exec("deno", [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "docker/generate.ts",
    `--only=${target}`,
  ])

  const refOutput = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      "docker/generate.ts",
      `--print-ref=${target}`,
    ],
    stdout: "piped",
  }).output()
  if (!refOutput.success) {
    throw new Error(`failed to resolve image ref for ${target}`)
  }
  const ref = new TextDecoder().decode(refOutput.stdout).trim()

  const buildArgs = ["build"]
  if (spec.platform) buildArgs.push("--platform", spec.platform)
  buildArgs.push("-t", ref, "-f", `docker/Dockerfile.${target}`, "docker")

  await builder.exec("docker", buildArgs)

  if (shouldPush) {
    await builder.exec("docker", ["push", ref])
  }
}
