import type { BuildkitePipeline } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"

export function pipelineMsgrammar(): BuildkitePipeline {
  return {
    steps: [{
      key: "check-build-x86_64-pc-windows-msvc",
      label: "Windows x64: check, test, build",
      agents: { queue: "windows" },
      command: "pwsh -NoProfile -File scripts/buildkite.ps1",
      timeout_in_minutes: 45,
      plugins: [
        `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
      ],
    }],
  }
}
