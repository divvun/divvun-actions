import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

const platforms = {
  macos: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  linux: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export function pipelineKbdgen() {
  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  for (const [os, archs] of Object.entries(platforms)) {
    for (const arch of archs) {
      const ext = os === "windows" ? ".exe" : ""
      pipeline.steps.push({
        group: `${os} ${arch}`,
        steps: [
          command({
            agents: {
              queue: os,
            },
            label: "Build and sign",
            command: [
              `cargo build --release --target ${arch}`,
              `divvun-actions sign target/${arch}/release/kbdgen${ext}`,
            ],
          }),
        ],
      })
    }
  }

  return pipeline
}
