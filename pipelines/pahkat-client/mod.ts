import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

const libPlatforms = {
  linux: [
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "x86_64-linux-android",
  ],
}

function buildLib(arch: string): { cmd: string; args: string[] } {
  if (arch.includes("android")) {
    return {
      cmd: "cargo",
      args: [
        "ndk",
        "-t",
        "armeabi-v7a",
        "-t",
        "arm64-v8a",
        "-o",
        "./lib",
        "build",
        "-vv",
        "--features",
        "ffi,prefix",
        "--release",
      ],
    }
  }

  return {
    cmd: "cargo",
    args: ["build", "--lib", "--release", "--target", arch],
  }
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

export function pipelinePahkatClient() {
  const libSteps = []
  const libStepKeys: string[] = []

  for (const [os, archs] of Object.entries(libPlatforms)) {
    for (const arch of archs) {
      const { cmd, args } = buildLib(arch)
      const buildKey = `build-lib-${os}-${arch}`
      libStepKeys.push(buildKey)

      if (arch.includes("android")) {
        libSteps.push(command({
          key: buildKey,
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            "cd pahkat-client-core",
            `${cmd} ${args.join(" ")}`,
            `buildkite-agent artifact upload "lib/**/*"`,
          ],
        }))
      } else {
        libSteps.push(command({
          key: buildKey,
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            "cd pahkat-client-core",
            `${cmd} ${args.join(" ")}`,
          ],
        }))
      }
    }
  }

  const pipeline: BuildkitePipeline = {
    steps: [
      {
        group: "libraries",
        steps: libSteps,
      },
      command({
        label: "Deploy Android",
        command: "divvun-actions run pahkat-client-deploy",
        depends_on: libStepKeys.filter((key) => key.includes("android")),
        agents: {
          queue: "linux",
        },
      }),
    ],
  }

  return pipeline
}

