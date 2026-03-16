import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { globOneFile } from "~/util/glob.ts"
import logger from "~/util/log.ts"

export const BUNDLE_ID = "no.uit.divvun.donate-your-speech"
export const BUNDLE_ID_ANDROID = "no.uit.divvun.donate_your_speech"
export const KEYCHAIN_NAME = "donate-speech-signing"
export const DEV_RELEASE_TAG = "dev"

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

  return {
    steps: [
      {
        group: "iOS",
        steps: [
          command({
            label: "Build & Sign",
            key: "build-ios",
            command: "divvun-actions run donate-speech-build-ios",
            agents: { queue: "macos" },
          }),
          ...(isMainBranch
            ? [command({
              label: "Deploy",
              command: "divvun-actions run donate-speech-deploy-ios",
              depends_on: "build-ios",
              agents: { queue: "macos" },
            })]
            : []),
        ],
      },
      {
        group: "Android",
        steps: [
          command({
            label: "Build & Sign",
            key: "build-android",
            command: "divvun-actions run donate-speech-build-android",
            agents: { queue: "linux" },
          }),
          ...(isMainBranch
            ? [command({
              label: "Deploy",
              command: "divvun-actions run donate-speech-deploy-android",
              depends_on: "build-android",
              agents: { queue: "linux" },
            })]
            : []),
        ],
      },
      {
        group: "macOS",
        steps: [
          command({
            label: "Build",
            key: "build-macos",
            command: "divvun-actions run donate-speech-build-macos",
            agents: { queue: "macos" },
          }),
          ...(isMainBranch
            ? [command({
              label: "Sign & Deploy",
              command: "divvun-actions run donate-speech-deploy-macos",
              depends_on: "build-macos",
              agents: { queue: "linux" },
            })]
            : []),
        ],
      },
      {
        group: "Windows",
        steps: [
          command({
            label: "Build",
            key: "build-windows",
            command: "divvun-actions run donate-speech-build-windows",
            agents: { queue: "windows" },
          }),
          ...(isMainBranch
            ? [command({
              label: "Sign & Deploy",
              command: "divvun-actions run donate-speech-deploy-windows",
              depends_on: "build-windows",
              agents: { queue: "linux" },
            })]
            : []),
        ],
      },
    ],
  }
}

/**
 * Upload artifacts to the shared "dev" GitHub Release.
 * Creates the release if it doesn't exist, otherwise adds/replaces assets
 * without removing other platforms' artifacts.
 */
export async function uploadToDevRelease(artifacts: string[]) {
  if (!builder.env.repo) {
    throw new Error("No repo found, cannot deploy")
  }

  const gh = new GitHub(builder.env.repo)
  const exists = await gh.releaseExists(DEV_RELEASE_TAG)

  if (!exists) {
    logger.info("Creating dev release...")
    await gh.ensureTagExists(DEV_RELEASE_TAG)
    await gh.createRelease(DEV_RELEASE_TAG, artifacts, {
      draft: false,
      prerelease: true,
      latest: false,
      verifyTag: true,
      name: "Dev Build",
    })
  } else {
    logger.info("Uploading to existing dev release...")
    await gh.uploadRelease(DEV_RELEASE_TAG, artifacts)
  }
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
export {
  runDonateSpeechBuildWindows,
  runDonateSpeechDeployWindows,
} from "./windows.ts"
