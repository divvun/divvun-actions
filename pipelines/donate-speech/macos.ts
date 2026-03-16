import * as path from "@std/path"
import * as builder from "~/builder.ts"
import macosSign from "~/services/macos-codesign.ts"
import { globOneDir } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { uploadToDevRelease } from "./mod.ts"

export async function runDonateSpeechBuildMacOS() {
  await builder.group("Installing dependencies", async () => {
    await builder.exec("pnpm", ["install", "--frozen-lockfile"])
  })

  await builder.group("Building macOS app", async () => {
    await builder.exec("pnpm", [
      "tauri",
      "build",
      "--config",
      "src-tauri/tauri.conf.release.json",
    ])
  })

  await builder.group("Uploading artifacts", async () => {
    const bundleDir = "src-tauri/target/release/bundle/macos"
    const appPath = await globOneDir(`${bundleDir}/*.app`)
    if (!appPath) {
      throw new Error(`No .app bundle found in ${bundleDir}`)
    }
    logger.info(`Found app bundle: ${appPath}`)

    // Use ditto to create a zip that preserves macOS metadata
    await builder.exec("ditto", [
      "-c",
      "-k",
      "--keepParent",
      appPath,
      "donate-your-speech-macos-unsigned.zip",
    ])
    await builder.uploadArtifacts("donate-your-speech-macos-unsigned.zip")
  })
}

export async function runDonateSpeechDeployMacOS() {
  using tempDir = await makeTempDir()

  await builder.group("Downloading artifacts", async () => {
    await builder.downloadArtifacts(
      "donate-your-speech-macos-unsigned.zip",
      tempDir.path,
    )
  })

  await builder.group("Extracting app bundle", async () => {
    const zipPath = path.join(
      tempDir.path,
      "donate-your-speech-macos-unsigned.zip",
    )
    await builder.exec("unzip", ["-q", zipPath, "-d", tempDir.path])
  })

  const appPath = await globOneDir(`${tempDir.path}/*.app`)
  if (!appPath) {
    throw new Error("No .app bundle found after extraction")
  }

  await builder.group("Signing and notarizing", async () => {
    logger.info(`Signing app bundle: ${appPath}`)
    await macosSign(appPath)
  })

  await builder.group("Uploading to GitHub Release", async () => {
    const signedZip = path.join(tempDir.path, "donate-your-speech-macos.zip")
    const appName = path.basename(appPath)
    await builder.exec("zip", ["-r", "-q", signedZip, appName], {
      cwd: tempDir.path,
    })

    logger.info(`Uploading to dev release: ${signedZip}`)
    await uploadToDevRelease([signedZip])
  })
}
