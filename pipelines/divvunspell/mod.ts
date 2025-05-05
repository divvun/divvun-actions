import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts";
import * as target from "~/target.ts";

const binPlatforms = {
  macos: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  linux: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

const libPlatforms = {
  macos: [
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
  ],
  linux: [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "x86_64-linux-android",
  ],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

function buildLib(arch: string): { cmd: string; args: string[] } {
  if (arch.includes("android")) {
    return {
      cmd: "cargo",
      args: ["ndk", "build", "--lib", "--release", "--target", arch],
    }
  }

  if (arch === "aarch64-unknown-linux-gnu") {
    return {
      cmd: "CROSS_CONTAINER_IN_CONTAINER=1 cross",
      args: ["build", "--lib", "--release", "--target", arch],
    }
  }

  return {
    cmd: "cargo",
    args: ["build", "--lib", "--release", "--target", arch],
  }
}

function buildBin(arch: string): { cmd: string; args: string[] } {
  const args = ["build", "--bin", "divvunspell", "--release", "--target", arch]
  const cmd = arch === "aarch64-unknown-linux-gnu"
    ? "CROSS_CONTAINER_IN_CONTAINER=1 cross"
    : "cargo"
  return { cmd, args }
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

export function pipelineDivvunspell() {
  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  for (const [os, archs] of Object.entries(binPlatforms)) {
    for (const arch of archs) {
      // const ext = os === "windows" ? ".exe" : ""
      const steps = []

      const { cmd, args } = buildBin(arch)

      if (os === "windows") {
        steps.push(command({
          agents: {
            queue: os,
          },
          label: "Build",
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      } else {
        steps.push(command({
          agents: {
            queue: os,
          },
          label: "Build",
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      }

      pipeline.steps.push({
        group: `cli ${os} ${arch}`,
        steps,
      })
    }
  }

  for (const [os, archs] of Object.entries(libPlatforms)) {
    for (const arch of archs) {
      // const ext = os === "windows" ? ".exe" : ""
      const steps = []

      const { cmd, args } = buildLib(arch)

      if (os === "windows") {
        steps.push(command({
          agents: {
            queue: os,
          },
          label: "Build",
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      } else {
        steps.push(command({
          agents: {
            queue: os,
          },
          label: "Build",
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      }

      pipeline.steps.push({
        group: `lib ${os} ${arch}`,
        steps,
      })
    }
  }

  return pipeline
}
