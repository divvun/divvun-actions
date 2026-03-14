import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import { googlePlayUpload } from "~/actions/google-play/upload.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { globOneFile } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { makeTempDir, makeTempFile } from "~/util/temp.ts"
import { setupSigningFromMatch } from "~/util/security.ts"

const BUNDLE_ID = "no.uit.divvun.donate-your-speech"
const BUNDLE_ID_ANDROID = "no.uit.divvun.donate_your_speech"
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
      command({
        label: "Build & Sign Android",
        key: "build-android",
        command: "divvun-actions run donate-speech-build-android",
        agents: { queue: "linux" },
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

export async function runDonateSpeechBuildAndroid() {
  const secrets = await builder.secrets()

  // Write the keystore file from base64 secret
  using keystoreFile = await makeTempFile({ suffix: ".jks" })
  const keystoreBytes = secrets.base64ByteArray(
    "android/divvun/donate-your-speech/keystore",
  )
  await Deno.writeFile(keystoreFile.path, keystoreBytes)

  await builder.group("Installing dependencies", async () => {
    await builder.exec("pnpm", ["install", "--frozen-lockfile"])
  })

  await builder.group("Initializing Android project", async () => {
    await builder.exec("pnpm", ["tauri", "android", "init"])
  })

  // Patch the generated build.gradle.kts to add signing config and version code
  await builder.group("Configuring signing and version code", async () => {
    const buildNumber = builder.env.buildNumber ?? "1"
    const buildGradlePath = "src-tauri/gen/android/app/build.gradle.kts"
    let buildGradle = await Deno.readTextFile(buildGradlePath)

    // Override versionCode with CI build number (Tauri derives one from semver but it doesn't auto-increment)
    // The first version manually uploaded had a derived versionCode of 1000. New version codes must be higher
    // than the highest current versionCode Google is aware of, so we add 1000 to the build number
    const versionCode = 1000 + Number(buildNumber)
    const versionCodePattern =
      /versionCode = tauriProperties\.getProperty\("tauri\.android\.versionCode", "\d+"\)\.toInt\(\)/
    const match = buildGradle.match(versionCodePattern)
    if (match) {
      logger.info(`Found versionCode line: ${match[0]}`)
      buildGradle = buildGradle.replace(
        versionCodePattern,
        `versionCode = ${versionCode}`,
      )
      logger.info(`Replaced with: versionCode = ${versionCode}`)
    } else {
      logger.info(`WARNING: versionCode pattern not found in build.gradle.kts`)
      logger.info(`File contents:\n${buildGradle}`)
    }

    // Add signingConfigs block and wire it to the release build type
    const signingConfig = `
    signingConfigs {
        create("release") {
            storeFile = file("${keystoreFile.path}")
            storePassword = "${
      secrets.get("android/divvun/donate-your-speech/storePassword")
    }"
            keyAlias = "${
      secrets.get("android/divvun/donate-your-speech/keyalias")
    }"
            keyPassword = "${
      secrets.get("android/divvun/donate-your-speech/keyPassword")
    }"
        }
    }`

    // Insert signingConfigs before buildTypes
    buildGradle = buildGradle.replace(
      "    buildTypes {",
      `${signingConfig}\n    buildTypes {`,
    )

    // Add signingConfig to release build type
    buildGradle = buildGradle.replace(
      '        getByName("release") {',
      '        getByName("release") {\n            signingConfig = signingConfigs.getByName("release")',
    )

    await Deno.writeTextFile(buildGradlePath, buildGradle)
    logger.info("Patched build.gradle.kts with release signing config")
  })

  await builder.group("Building Android app", async () => {
    await builder.exec("pnpm", [
      "tauri",
      "android",
      "build",
      "--target",
      "aarch64",
      "--config",
      "src-tauri/tauri.conf.release.json",
    ])
  })

  await builder.group("Uploading artifacts", async () => {
    const aabPath = await findBuildArtifact(
      "aab",
      "src-tauri/gen/android/app/build/outputs",
    )
    logger.info(`Found AAB: ${aabPath}`)
    await builder.uploadArtifacts(aabPath)
  })
}

export async function runDonateSpeechDeployAndroid() {
  const secrets = await builder.secrets()

  using tempDir = await makeTempDir()

  await builder.group("Downloading artifacts", async () => {
    await builder.downloadArtifacts("**/*.aab", tempDir.path)
  })

  await builder.group("Uploading to Google Play", async () => {
    const aabPath = await globOneFile("**/*.aab", { root: tempDir.path })
    if (!aabPath) {
      throw new Error("No AAB found in downloaded artifacts")
    }

    logger.info(`Uploading AAB: ${aabPath}`)
    const serviceAccountJson = secrets.get(
      "android/divvun/googleServiceAccountJson",
    )
    await googlePlayUpload({
      serviceAccountJson,
      packageName: BUNDLE_ID_ANDROID,
      aabPath,
    })
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

async function findBuildArtifact(
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
