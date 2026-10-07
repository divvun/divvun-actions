import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import * as builder from "~/builder.ts"
import { isKbdgenV4Build } from "~/actions/kbdgen/v4.ts"
import { hasTextService } from "~/actions/kbd-tsf/installer.ts"
import { TIP_BUILD_KEY, tipSteps } from "./tip.ts"
import { v4PublishStep } from "./v4.ts"

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

  const buildStepKeys: string[] = []

  for (const [os, archs] of Object.entries(platforms)) {
    for (const arch of archs) {
      const ext = os === "windows" ? ".exe" : ""
      const steps = []
      const buildKey = `build-${os}-${arch}`
      buildStepKeys.push(buildKey)

      if (os === "windows") {
        steps.push(command({
          key: buildKey,
          agents: {
            queue: os,
          },
          label: "Build and sign",
          command: [
            `msvc-env ${
              msvcEnvCmd(arch)
            } | Invoke-Expression; cargo build --bin kbdgen --release --target ${arch}`,
            `divvun-actions sign target/${arch}/release/kbdgen${ext}`,
            `buildkite-agent artifact upload target/${arch}/release/kbdgen${ext}`,
          ],
          plugins: [
            {
              "cache#v1.7.0": {
                manifest: "Cargo.lock",
                path: "target",
                restore: "file",
                save: "file",
                "key-extra": arch,
              },
            },
          ],
        }))
      } else {
        const cargoCmd = os !== "linux" || arch === "x86_64-unknown-linux-gnu"
          ? "cargo"
          : "cross"

        steps.push(command({
          key: buildKey,
          agents: {
            queue: os,
          },
          label: "Build",
          command: [
            `${cargoCmd} build --bin kbdgen --release --target ${arch}`,
            `buildkite-agent artifact upload target/${arch}/release/kbdgen${ext}`,
          ],
          plugins: os === "linux"
            ? [
              {
                "cache#v1.7.0": {
                  manifest: "Cargo.lock",
                  path: "target",
                  restore: "file",
                  save: "file",
                  "key-extra": arch,
                },
              },
            ]
            : [],
        }))
      }

      pipeline.steps.push({
        group: `${os} ${arch}`,
        steps,
      })
    }
  }

  // The pipeline is generated in the checkout, so only commits that have the
  // text service crate build it.
  const textService = hasTextService(".")
  if (textService) {
    pipeline.steps.push({
      group: "Text service",
      steps: tipSteps("build-windows-x86_64-pc-windows-msvc", command),
    })
  }

  if (isKbdgenV4Build()) {
    pipeline.steps.push(v4PublishStep(
      textService ? [...buildStepKeys, TIP_BUILD_KEY] : buildStepKeys,
      command,
    ))
  }

  if (builder.env.branch === "main") {
    pipeline.steps.push(command({
      label: "Deploy",
      command: "divvun-actions run kbdgen-deploy",
      depends_on: buildStepKeys,
      agents: {
        queue: "linux",
      },
    }))
  }

  return pipeline
}
