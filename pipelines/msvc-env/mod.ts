import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

const platforms = {
  windows: ["x86_64-pc-windows-msvc"],
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

export function pipelineMsvcEnv() {
  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  for (const [os, archs] of Object.entries(platforms)) {
    for (const arch of archs) {
      const ext = os === "windows" ? ".exe" : ""
      const steps = []

      if (os === "windows") {
        steps.push(command({
          agents: {
            queue: os,
          },
          label: "Build and sign",
          command: [
            `cargo build --release --target ${arch}`,
            `divvun-actions sign target/${arch}/release/kbdgen${ext}`,
          ],
        }))
      } else {
        const cargoCmd = os !== "linux" || arch === "x86_64-unknown-linux-gnu"
          ? "cargo"
          : "cross"

        steps.push(command({
          agents: {
            queue: os,
          },
          label: "Build",
          command: [
            `${cargoCmd} build --release --target ${arch}`,
          ],
        }))
      }

      pipeline.steps.push({
        group: `${os} ${arch}`,
        steps,
      })
    }
  }

  return pipeline
}
