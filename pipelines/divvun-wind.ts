import type { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"

const TARGET = "x86_64-pc-windows-msvc"
const RELEASE_DIR = `target/${TARGET}/release`
const PAYLOADS = [
  "divvun-wind.exe",
  "divvun-wind-symbols.exe",
  "divvun_keyboard_labels.dll",
]

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
        command: [
          // Buildkite unescapes $$ for the Windows agent's PowerShell. Import
          // the full MSVC environment and stop before uploading on any failure.
          `$$ErrorActionPreference = 'Stop'; $$windMsvcEnv = msvc-env x64; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }; $$windMsvcEnv | Invoke-Expression; & ./scripts/ci.ps1 -Build; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }`,
          ...PAYLOADS.map((name) =>
            `buildkite-agent artifact upload ${RELEASE_DIR}/${name}; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }`
          ),
          `buildkite-agent artifact upload '${RELEASE_DIR}/*.pdb'; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }`,
        ],
      }),
    ],
  }
}

// This is source validation and unsigned build artifacts only. Outto packaging,
// signing and release publication will be added when Wind's lifecycle is ready.
// The Windows queue uses Server Core; it cannot verify Windows 11 Explorer UI.
