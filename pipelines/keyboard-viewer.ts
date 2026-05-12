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

export function pipelineKeyboardViewer(): BuildkitePipeline {
  return {
    steps: [
      command({
        label: "Build & Push",
        command: "divvun-actions run keyboard-viewer-deploy",
        agents: { queue: "linux" },
      }),
    ],
  }
}

export async function runKeyboardViewerDeploy() {
  await builder.exec("docker", [
    "build",
    "-t",
    "ghcr.io/divvun/keyboard-viewer:latest",
    ".",
  ])
  await builder.exec("docker", [
    "push",
    "ghcr.io/divvun/keyboard-viewer:latest",
  ])
}
