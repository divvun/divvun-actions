import * as fs from "@std/fs"
import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { Security } from "~/util/security.ts"

const BUNDLE_ID = "no.uit.divvun.donate-your-speech"

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
    )
  }

  return pipeline
}

export async function runDonateSpeechBuildIOS() {
  const secrets = await builder.secrets()

  await builder.group("Installing signing credentials", async () => {
    // Unlock the login keychain so match can import the certificate
    await Security.unlockKeychain("login", secrets.get("macos/adminPassword"))

    // Run fastlane match to install cert + provisioning profile
    await builder.exec("fastlane", [
      "match",
      "appstore",
      "--readonly",
      "--app_identifier",
      BUNDLE_ID,
    ], {
      env: {
        MATCH_GIT_URL: secrets.get("ios/matchGitUrl"),
        MATCH_PASSWORD: secrets.get("ios/matchPassword"),
        MATCH_KEYCHAIN_NAME: "login.keychain",
        MATCH_KEYCHAIN_PASSWORD: secrets.get("macos/adminPassword"),
      },
    })
  })

  await builder.group("Installing dependencies", async () => {
    await builder.exec("pnpm", ["install", "--frozen-lockfile"])
  })

  await builder.group("Initializing iOS project", async () => {
    await builder.exec("pnpm", ["tauri", "ios", "init"])
  })

  await builder.group("Building iOS app", async () => {
    await builder.exec("pnpm", [
      "tauri",
      "ios",
      "build",
      "--export-method",
      "app-store-connect",
      "--config",
      "src-tauri/tauri.conf.release.json",
    ], {
      env: {
        APPLE_DEVELOPMENT_TEAM: secrets.get("macos/teamId"),
      },
    })
  })

  await builder.group("Uploading artifacts", async () => {
    const ipaPath = await findIpa()
    logger.info(`Found IPA: ${ipaPath}`)
    await builder.uploadArtifacts(ipaPath)
  })
}

export async function runDonateSpeechDeployIOS() {
  const secrets = await builder.secrets()

  using tempDir = await makeTempDir()

  await builder.group("Downloading artifacts", async () => {
    await builder.downloadArtifacts("**/*.ipa", tempDir.path)
  })

  await builder.group("Uploading to App Store Connect", async () => {
    const ipaPath = await findFile(path.join(tempDir.path, "**/*.ipa"))
    if (!ipaPath) {
      throw new Error("No IPA found in downloaded artifacts")
    }

    logger.info(`Uploading IPA: ${ipaPath}`)
    const apiKey = JSON.parse(secrets.get("macos/appStoreKeyJson"))
    await fastlanePilotUpload({
      apiKey,
      ipaPath,
    })
  })
}

async function findIpa(): Promise<string> {
  // Tauri iOS builds output the IPA under src-tauri/gen/apple/build/
  const searchPaths = [
    "src-tauri/gen/apple/build/**/*.ipa",
    "**/*.ipa",
  ]

  for (const pattern of searchPaths) {
    const result = await findFile(pattern)
    if (result) return result
  }

  throw new Error(
    "No IPA found. Searched: " + searchPaths.join(", "),
  )
}

async function findFile(pattern: string): Promise<string | null> {
  const files = await fs.expandGlob(pattern, { followSymlinks: false })
  for await (const file of files) {
    if (file.isFile) {
      return file.path
    }
  }
  return null
}
