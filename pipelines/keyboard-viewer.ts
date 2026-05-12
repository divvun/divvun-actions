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
        label: "Lint",
        command: "divvun-actions run keyboard-viewer-lint",
        agents: { queue: "linux" },
      }),
      command({
        label: "Build",
        command: "divvun-actions run keyboard-viewer-build",
        agents: { queue: "linux" },
      }),
      command({
        label: "Push",
        command: "divvun-actions run keyboard-viewer-push",
        agents: { queue: "linux" },
        branches: "main",
      }),
    ],
  }
}

export async function runKeyboardViewerLint() {
  await builder.exec("deno", ["fmt", "--check"])
  await builder.exec("deno", ["lint"])
  await builder.exec("deno", ["check"])
}

export async function runKeyboardViewerBuild() {
  await builder.exec("docker", [
    "build",
    "-t",
    "ghcr.io/divvun/keyboard-viewer:latest",
    ".",
  ])
}

export async function runKeyboardViewerPush() {
  await builder.exec("docker", [
    "push",
    "ghcr.io/divvun/keyboard-viewer:latest",
  ])
}
