import { encodeBase64 } from "@std/encoding/base64"
import * as fs from "@std/fs"
import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import { makeTempDir, makeTempFile } from "~/util/temp.ts"
import { Security } from "~/util/security.ts"
import type { SecretsStore } from "~/util/openbao.ts"

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

  let certificate: string
  let mobileProvision: string
  await builder.group("Fetching signing credentials from match", async () => {
    const credentials = await fetchMatchCredentials(secrets)
    certificate = credentials.certificate
    mobileProvision = credentials.mobileProvision
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
        IOS_CERTIFICATE: certificate!,
        IOS_CERTIFICATE_PASSWORD: "",
        IOS_MOBILE_PROVISION: mobileProvision!,
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

async function fetchMatchCredentials(secrets: SecretsStore): Promise<{
  certificate: string
  mobileProvision: string
}> {
  const keychainName = "match-donate-speech"
  const keychainPassword = secrets.get("macos/adminPassword")

  // Create a temporary keychain for match to import into
  await Security.createKeychain(keychainName, keychainPassword)
  try {
    await Security.unlockKeychain(keychainName, keychainPassword)
    await Security.setKeychainTimeout(keychainName, 3600)

    // Run fastlane match to fetch and install cert + profile
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
        MATCH_KEYCHAIN_NAME: `${keychainName}.keychain`,
        MATCH_KEYCHAIN_PASSWORD: keychainPassword,
      },
    })

    // Export the certificate from the temp keychain as .p12
    using certFile = await makeTempFile({ suffix: ".p12" })
    const exportResult = await new Deno.Command("security", {
      args: [
        "export",
        "-k",
        `${Deno.env.get("HOME")}/Library/Keychains/${keychainName}.keychain-db`,
        "-t",
        "identities",
        "-f",
        "pkcs12",
        "-P",
        "",
        "-o",
        certFile.path,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output()

    if (!exportResult.success) {
      const stderr = new TextDecoder().decode(exportResult.stderr)
      throw new Error(`Failed to export certificate from keychain: ${stderr}`)
    }

    const certData = await Deno.readFile(certFile.path)
    const certificate = encodeBase64(certData)

    // Find the provisioning profile installed by match
    const profilesDir = path.join(
      Deno.env.get("HOME")!,
      "Library/MobileDevice/Provisioning Profiles",
    )
    const mobileProvision = await findAndEncodeProfile(profilesDir, BUNDLE_ID)

    return { certificate, mobileProvision }
  } finally {
    await Security.deleteKeychain(keychainName).catch(() => {})
  }
}

async function findAndEncodeProfile(
  profilesDir: string,
  bundleId: string,
): Promise<string> {
  // Find the provisioning profile matching our bundle ID
  for await (const entry of fs.expandGlob(path.join(profilesDir, "*.mobileprovision"))) {
    const result = await new Deno.Command("security", {
      args: ["cms", "-D", "-i", entry.path],
      stdout: "piped",
      stderr: "piped",
    }).output()

    if (!result.success) continue

    const plist = new TextDecoder().decode(result.stdout)
    if (plist.includes(bundleId)) {
      const data = await Deno.readFile(entry.path)
      return encodeBase64(data)
    }
  }

  throw new Error(
    `No provisioning profile found for ${bundleId} in ${profilesDir}`,
  )
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
