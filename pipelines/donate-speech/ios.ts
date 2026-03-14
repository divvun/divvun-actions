import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import * as builder from "~/builder.ts"
import { globOneFile } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { makeTempDir, makeTempFile } from "~/util/temp.ts"
import { setupSigningFromMatch } from "~/util/security.ts"
import { BUNDLE_ID, KEYCHAIN_NAME, findBuildArtifact } from "./mod.ts"

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
    const result = await setupSigningFromMatch({
      bundleId: BUNDLE_ID,
      keychainName: KEYCHAIN_NAME,
      keychainPassword,
      matchGitUrl: secrets.get("ios/matchGitUrl"),
      matchPassword: secrets.get("ios/matchPassword"),
    })
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
    const ipaPath = await findBuildArtifact("ipa", "src-tauri/gen/apple/build")
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
    const ipaPath = await globOneFile("**/*.ipa", { root: tempDir.path })
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
