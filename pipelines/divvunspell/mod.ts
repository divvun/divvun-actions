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
      args: [
        "ndk",
        "--bindgen",
        "--target",
        arch,
        "build",
        "--lib",
        "--release",
        "-v",
      ],
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
  const binSteps = []
  const libSteps = []

  for (const [os, archs] of Object.entries(binPlatforms)) {
    for (const arch of archs) {
      const { cmd, args } = buildBin(arch)

      if (os === "windows") {
        binSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      } else {
        binSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      }
    }
  }

  for (const [os, archs] of Object.entries(libPlatforms)) {
    for (const arch of archs) {
      const { cmd, args } = buildLib(arch)

      if (os === "windows") {
        libSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      } else {
        libSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      }
    }
  }

  const pipeline: BuildkitePipeline = {
    steps: [{
      group: "binaries",
      steps: binSteps,
    }, {
      group: "libraries",
      steps: libSteps,
    }],
  }

  return pipeline
}
