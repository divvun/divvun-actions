import { encodeBase64 } from "@std/encoding/base64"
import * as fs from "@std/fs"
import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import { makeTempDir, makeTempFile } from "~/util/temp.ts"
import {
  downloadAppleWWDRCA,
  Security,
} from "~/util/security.ts"

const BUNDLE_ID = "no.uit.divvun.donate-your-speech"
const KEYCHAIN_NAME = "donate-speech-signing"

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
  const apiKey = JSON.parse(secrets.get("macos/appStoreKeyJson"))
  const keychainPassword = secrets.get("macos/adminPassword")

  // Write the App Store Connect API private key to a .p8 file
  using apiKeyFile = await makeTempFile({ suffix: ".p8" })
  await Deno.writeTextFile(apiKeyFile.path, apiKey.key)

  // Set up signing credentials from fastlane match
  let iosCertificate: string
  let iosMobileProvision: string

  await builder.group("Installing signing credentials", async () => {
    const result = await setupSigningFromMatch(secrets, keychainPassword)
    iosCertificate = result.certificate
    iosMobileProvision = result.mobileProvision
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
        // API key vars make Tauri skip signing during build phase
        APPLE_API_KEY: apiKey.key_id,
        APPLE_API_ISSUER: apiKey.issuer_id,
        APPLE_API_KEY_PATH: apiKeyFile.path,
        // Manual signing vars for the export phase
        IOS_CERTIFICATE: iosCertificate!,
        IOS_CERTIFICATE_PASSWORD: "",
        IOS_MOBILE_PROVISION: iosMobileProvision!,
        // Ensure macOS system base64 is used (supports --decode -o),
        // not GNU coreutils base64 from Homebrew (which doesn't)
        PATH: `/usr/bin:${Deno.env.get("PATH")}`,
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

async function setupSigningFromMatch(
  secrets: Awaited<ReturnType<typeof builder.secrets>>,
  keychainPassword: string,
): Promise<{ certificate: string; mobileProvision: string }> {
  // Create a dedicated keychain so we can cleanly export just the match cert
  await Security.createKeychain(KEYCHAIN_NAME, keychainPassword)

  try {
    await Security.unlockKeychain(KEYCHAIN_NAME, keychainPassword)
    await Security.setKeychainTimeout(KEYCHAIN_NAME, 3600)

    // Import Apple WWDR intermediate cert so the cert chain is complete
    // (required for security find-identity to recognize the distribution cert)
    const wwdrCertPath = await downloadAppleWWDRCA("G3")
    await Security.import(KEYCHAIN_NAME, wwdrCertPath)

    // Run fastlane match to install cert into keychain
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
        MATCH_KEYCHAIN_NAME: `${KEYCHAIN_NAME}.keychain`,
        MATCH_KEYCHAIN_PASSWORD: keychainPassword,
      },
    })

    // Export the distribution certificate from the keychain as .p12
    using certFile = await makeTempFile({ suffix: ".p12" })
    const keychainPath = `${Deno.env.get("HOME")}/Library/Keychains/${KEYCHAIN_NAME}.keychain-db`

    const exportResult = await new Deno.Command("security", {
      args: [
        "export",
        "-k", keychainPath,
        "-t", "identities",
        "-f", "pkcs12",
        "-P", "",
        "-o", certFile.path,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output()

    if (!exportResult.success) {
      const stderr = new TextDecoder().decode(exportResult.stderr)
      throw new Error(`Failed to export certificate: ${stderr}`)
    }

    const certData = await Deno.readFile(certFile.path)
    if (certData.length === 0) {
      throw new Error("Exported certificate is empty — cert may not have been imported properly")
    }
    const certificate = encodeBase64(certData)
    logger.info(`Exported certificate from keychain (${certData.length} bytes)`)

    // Decrypt the provisioning profile directly from the match git repo.
    // Searching ~/Library/MobileDevice/Provisioning Profiles/ is unreliable
    // on CI — the profile may not be installed there by match on all machines.
    using matchParentDir = await makeTempDir()
    const matchDir = path.join(matchParentDir.path, "match")
    const matchGitUrl = secrets.get("ios/matchGitUrl")
    const matchPassword = secrets.get("ios/matchPassword")

    await builder.exec("git", ["clone", "--depth", "1", matchGitUrl, matchDir])

    const encryptedProfilePath = path.join(
      matchDir,
      "profiles/appstore/AppStore_no.uit.divvun.donate-your-speech.mobileprovision",
    )

    try {
      await Deno.stat(encryptedProfilePath)
    } catch {
      throw new Error(`Encrypted profile not found in match repo at: profiles/appstore/AppStore_no.uit.divvun.donate-your-speech.mobileprovision`)
    }

    const decryptResult = await new Deno.Command("ruby", {
      args: [
        "-e",
        [
          `require "fastlane"`,
          `e = Match::Encryption::MatchDataEncryption.new`,
          `$stdout.write(e.decrypt(File.binread(ARGV[0]), ARGV[1]))`,
        ].join("; "),
        encryptedProfilePath,
        matchPassword,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output()

    if (!decryptResult.success) {
      const stderr = new TextDecoder().decode(decryptResult.stderr)
      throw new Error(`Failed to decrypt provisioning profile: ${stderr}`)
    }

    if (decryptResult.stdout.length === 0) {
      throw new Error("Decrypted provisioning profile is empty")
    }

    logger.info(`Decrypted provisioning profile (${decryptResult.stdout.length} bytes)`)
    const mobileProvision = encodeBase64(decryptResult.stdout)

    return { certificate, mobileProvision }
  } finally {
    await Security.deleteKeychain(KEYCHAIN_NAME).catch(() => {})
  }
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
