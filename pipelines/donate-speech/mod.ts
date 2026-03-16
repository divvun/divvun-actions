import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { globOneFile } from "~/util/glob.ts"

export const BUNDLE_ID = "no.uit.divvun.donate-your-speech"
export const BUNDLE_ID_ANDROID = "no.uit.divvun.donate_your_speech"
export const KEYCHAIN_NAME = "donate-speech-signing"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export function pipelineDonateSpeech(): BuildkitePipeline {
  const isMainBranch = builder.env.branch === "main"

  const pipeline: BuildkitePipeline = {
    steps: [
      command({
        label: "Build & Sign iOS",
        key: "build-ios",
        command: "divvun-actions run donate-speech-build-ios",
        agents: { queue: "macos" },
      }),
      command({
        label: "Build & Sign Android",
        key: "build-android",
        command: "divvun-actions run donate-speech-build-android",
        agents: { queue: "linux" },
      }),
      command({
        label: "Build macOS",
        key: "build-macos",
        command: "divvun-actions run donate-speech-build-macos",
        agents: { queue: "macos" },
      }),
    ],
  }

  if (isMainBranch) {
    pipeline.steps.push(
      command({
        label: "Deploy iOS",
        command: "divvun-actions run donate-speech-deploy-ios",
        depends_on: "build-ios",
        agents: { queue: "macos" },
      }),
      command({
        label: "Deploy Android",
        command: "divvun-actions run donate-speech-deploy-android",
        depends_on: "build-android",
        agents: { queue: "linux" },
      }),
      command({
        label: "Sign & Deploy macOS",
        command: "divvun-actions run donate-speech-deploy-macos",
        depends_on: "build-macos",
        agents: { queue: "linux" },
      }),
    )
  }

  return pipeline
}

export async function findBuildArtifact(
  extension: string,
  primaryDir: string,
): Promise<string> {
  const patterns = [`${primaryDir}/**/*.${extension}`, `**/*.${extension}`]
  for (const pattern of patterns) {
    const result = await globOneFile(pattern)
    if (result) return result
  }
  throw new Error(
    `No .${extension} found. Searched: ${patterns.join(", ")}`,
  )
}

export { runDonateSpeechBuildIOS, runDonateSpeechDeployIOS } from "./ios.ts"
export {
  runDonateSpeechBuildAndroid,
  runDonateSpeechDeployAndroid,
} from "./android.ts"
export {
  runDonateSpeechBuildMacOS,
  runDonateSpeechDeployMacOS,
} from "./macos.ts"
