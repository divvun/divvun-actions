import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"

const TARGETS = ["alpine", "linux"] as const
type Target = typeof TARGETS[number]

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
      command: [
        "deno task docker:check",
      ],
      agents: { queue: "linux" },
    }),
    { wait: null },
  ]

  for (const target of TARGETS) {
    steps.push(
      command({
        key: `build-${target}`,
        label: `:whale: Build ${target}`,
        command: [
          `divvun-actions run divvun-actions-build-image ${target} ${
            isMain ? "push" : "no-push"
          }`,
        ],
        agents: { queue: "linux" },
        depends_on: "drift-check",
      }),
    )
  }

  return { steps }
}

export async function runDivvunActionsBuildImage(
  target: string,
  pushArg: string,
) {
  if (!TARGETS.includes(target as Target)) {
    throw new Error(
      `Unknown target: ${target}. Expected one of: ${TARGETS.join(", ")}`,
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

  await builder.exec("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "-t",
    ref,
    "-f",
    `docker/Dockerfile.${target}`,
    "docker",
  ])

  if (shouldPush) {
    await builder.exec("docker", ["push", ref])
  }
}
