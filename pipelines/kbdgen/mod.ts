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

const msvcEnvCmd = (arch: string) => {
  if (arch.startsWith("aarch64")) {
    return "arm64"
  }
  return "x64"
}

export function pipelineKbdgen() {
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
            "echo $$PATH",
            `eval $(msvc-env ${msvcEnvCmd(arch)} --sh) && export PATH=\`/usr/bin/cygpath -p $$PATH\` && echo $$PATH && cargo build --release --target ${arch}`,
            `divvun-actions sign target/${arch}/release/kbdgen${ext}`,
          ],
        }))
      } else {
        const cargoCmd = os !== "linux" || arch === "x86_64-unknown-linux-gnu"
          ? "cargo"
          : "CROSS_CONTAINER_IN_CONTAINER=1 cross"

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
