import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import * as builder from "~/builder.ts"
import { downloadBinaryCmd } from "~/util/artifact_download.ts"
import {
  isKbdgenV4Build,
  KBDGEN_WINDOWS_TARGET,
} from "~/actions/kbdgen/v4.ts"
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

function kbdgenPath(os: string, arch: string): string {
  return `target/${arch}/release/kbdgen${os === "windows" ? ".exe" : ""}`
}

const msvcEnvCmd = (arch: string) => {
  if (arch.startsWith("aarch64")) {
    return "arm64"
  }
  return "x64"
}

/**
 * Downloads the unsigned kbdgen that `buildKey` uploaded for a Windows or
 * macOS `arch`, signs it and uploads it as `signed/<path>`. It runs on Linux,
 * where a failed signing fails the step, rather than on the Windows agent,
 * whose PowerShell carries on past a failed native command.
 */
function createSignStep(
  os: "windows" | "macos",
  arch: string,
  buildKey: string,
): CommandStep {
  const src = kbdgenPath(os, arch)
  const signed = `signed/${src}`
  const signCommand = os === "windows"
    ? `divvun-actions sign ${src}`
    : `divvun-actions run macos-sign ${src}`
  return command({
    key: `sign-${os}-${arch}`,
    label: "Sign",
    agents: { queue: "linux" },
    command: [
      "echo '--- Downloading unsigned binary'",
      downloadBinaryCmd(src),
      "echo '--- Signing'",
      signCommand,
      "echo '--- Uploading signed binary'",
      `mkdir -p signed/target/${arch}/release`,
      `mv ${src} ${signed}`,
      `buildkite-agent artifact upload ${signed}`,
    ],
    depends_on: buildKey,
  })
}

export function pipelineKbdgen() {
  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  // The keys of the steps that upload each target's shipped binary: the sign
  // step for Windows and macOS, the build step for Linux.
  const binaryStepKeys: string[] = []

  for (const [os, archs] of Object.entries(platforms)) {
    for (const arch of archs) {
      const steps: CommandStep[] = []
      const buildKey = `build-${os}-${arch}`
      const upload = `buildkite-agent artifact upload ${kbdgenPath(os, arch)}`

      if (os === "windows") {
        steps.push(command({
          key: buildKey,
          agents: {
            queue: os,
          },
          label: "Build",
          command: [
            `msvc-env ${
              msvcEnvCmd(arch)
            } | Invoke-Expression; cargo build --bin kbdgen --release --target ${arch}; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }`,
            upload,
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
            upload,
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

      if (os === "windows" || os === "macos") {
        const signStep = createSignStep(os, arch, buildKey)
        steps.push(signStep)
        binaryStepKeys.push(signStep.key!)
      } else {
        binaryStepKeys.push(buildKey)
      }

      pipeline.steps.push({
        group: arch,
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
      steps: tipSteps(`sign-windows-${KBDGEN_WINDOWS_TARGET}`, command),
    })
  }

  if (isKbdgenV4Build()) {
    pipeline.steps.push(v4PublishStep(
      textService ? [...binaryStepKeys, TIP_BUILD_KEY] : binaryStepKeys,
      command,
    ))
  }

  if (builder.env.branch === "main") {
    pipeline.steps.push(command({
      label: "Deploy",
      command: "divvun-actions run kbdgen-deploy",
      depends_on: binaryStepKeys,
      agents: {
        queue: "linux",
      },
    }))
  }

  return pipeline
}
