import { googlePlayUpload } from "~/actions/google-play/upload.ts"
import * as builder from "~/builder.ts"
import { globOneFile } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { makeTempDir, makeTempFile } from "~/util/temp.ts"
import { BUNDLE_ID_ANDROID, findBuildArtifact } from "./mod.ts"

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
    if (!versionCodePattern.test(buildGradle)) {
      throw new Error(
        "versionCode pattern not found in build.gradle.kts — Tauri may have changed its output format",
      )
    }
    buildGradle = buildGradle.replace(
      versionCodePattern,
      `versionCode = ${versionCode}`,
    )
    logger.info(`Set versionCode = ${versionCode}`)

    // Add signingConfigs block and wire it to the release build type
    const escapeGradleString = (s: string) =>
      s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

    const storePassword = escapeGradleString(
      secrets.get("android/divvun/donate-your-speech/storePassword"),
    )
    const keyAlias = escapeGradleString(
      secrets.get("android/divvun/donate-your-speech/keyalias"),
    )
    const keyPassword = escapeGradleString(
      secrets.get("android/divvun/donate-your-speech/keyPassword"),
    )

    const signingConfig = `
    signingConfigs {
        create("release") {
            storeFile = file("${escapeGradleString(keystoreFile.path)}")
            storePassword = "${storePassword}"
            keyAlias = "${keyAlias}"
            keyPassword = "${keyPassword}"
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
