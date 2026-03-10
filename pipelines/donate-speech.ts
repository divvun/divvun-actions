import * as fs from "@std/fs"
import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import { Security } from "~/util/security.ts"
import { makeTempDir, makeTempFile } from "~/util/temp.ts"

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

  await builder.group("Setting up signing", async () => {
    await Security.unlockKeychain("login", secrets.get("macos/adminPassword"))

    using appStoreKeyJsonPath = await makeTempFile({ suffix: ".json" })
    await Deno.writeTextFile(
      appStoreKeyJsonPath.path,
      secrets.get("macos/appStoreKeyJson"),
    )

    // Run fastlane match to download certs and provisioning profiles
    await builder.exec("fastlane", [
      "match",
      "appstore",
      "--app_identifier",
      BUNDLE_ID,
      "--readonly",
      "true",
    ], {
      env: {
        GITHUB_USERNAME: secrets.get("github/username"),
        GITHUB_TOKEN: secrets.get("github/token"),
        MATCH_GIT_URL: secrets.get("ios/matchGitUrl"),
        MATCH_PASSWORD: secrets.get("ios/matchPassword"),
        MATCH_KEYCHAIN_NAME: "login.keychain",
        MATCH_KEYCHAIN_PASSWORD: secrets.get("macos/adminPassword"),
        APP_STORE_KEY_JSON: appStoreKeyJsonPath.path,
        LANG: "en_US.UTF-8",
      },
    })
  })

  await builder.group("Installing dependencies", async () => {
    await builder.exec("pnpm", ["install", "--frozen-lockfile"])
  })

  await builder.group("Initializing iOS project", async () => {
    await builder.exec("pnpm", ["tauri", "ios", "init"])
  })

  const provisioningProfile = `match AppStore ${BUNDLE_ID}`

  await builder.group("Building iOS app", async () => {
    await builder.exec("pnpm", [
      "tauri",
      "ios",
      "build",
      "--export-method",
      "app-store-connect",
      "--config",
      "src-tauri/tauri.conf.release.json",
      "--",
      `CODE_SIGN_STYLE=Manual`,
      `CODE_SIGN_IDENTITY=iPhone Distribution`,
      `PROVISIONING_PROFILE_SPECIFIER=${provisioningProfile}`,
      `DEVELOPMENT_TEAM=${secrets.get("macos/teamId")}`,
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
