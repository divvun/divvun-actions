import type { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"

const TARGET = "x86_64-pc-windows-msvc"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineDivvunWind(): BuildkitePipeline {
  return {
    steps: [
      command({
        key: `check-build-${TARGET}`,
        label: "Windows x64: check, test, build",
        agents: { queue: "windows" },
        // Keep PowerShell syntax in the script, outside Buildkite's command
        // interpolation and shell quoting.
        command: "pwsh -NoProfile -File scripts/buildkite.ps1",
      }),
    ],
  }
}

// This is source validation and unsigned build artifacts only. Outto packaging,
// signing and release publication will be added when Wind's lifecycle is ready.
// The Windows queue uses Server Core; it cannot verify Windows 11 Explorer UI.
