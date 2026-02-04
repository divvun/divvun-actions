import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineBorealium(): BuildkitePipeline {
  return {
    steps: [
      command({
        label: "Build & Push",
        command: "divvun-actions run borealium-deploy",
        agents: { queue: "linux" },
      }),
    ],
  }
}

export async function runBorealiumDeploy() {
  await builder.exec("docker", [
    "build",
    "-t",
    "ghcr.io/divvun/borealium:latest",
    ".",
  ])
  await builder.exec("docker", [
    "push",
    "ghcr.io/divvun/borealium:latest",
  ])
}
