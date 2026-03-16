import * as path from "@std/path"
import * as builder from "~/builder.ts"
import sign from "~/services/windows-codesign.ts"
import { globOneFile } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { uploadToDevRelease } from "./mod.ts"

export async function runDonateSpeechBuildWindows() {
  await builder.group("Installing dependencies", async () => {
    await builder.exec("pnpm", ["install", "--frozen-lockfile"])
  })

  await builder.group("Building Windows app", async () => {
    await builder.exec("pnpm", [
      "tauri",
      "build",
      "--config",
      "src-tauri/tauri.conf.release.json",
    ])
  })

  await builder.group("Uploading artifacts", async () => {
    const bundleDir = "src-tauri/target/release/bundle"
    const msiPath = await globOneFile(`${bundleDir}/msi/*.msi`)
    if (!msiPath) {
      throw new Error(`No .msi installer found in ${bundleDir}/msi`)
    }
    logger.info(`Found MSI: ${msiPath}`)

    const artifactName = "donate-your-speech-windows-unsigned.msi"
    await Deno.copyFile(msiPath, artifactName)
    await builder.uploadArtifacts(artifactName)
  })
}

export async function runDonateSpeechDeployWindows() {
  using tempDir = await makeTempDir()

  await builder.group("Downloading artifacts", async () => {
    await builder.downloadArtifacts(
      "donate-your-speech-windows-unsigned.msi",
      tempDir.path,
    )
  })

  const unsignedPath = path.join(
    tempDir.path,
    "donate-your-speech-windows-unsigned.msi",
  )
  const signedPath = path.join(tempDir.path, "donate-your-speech-windows.msi")

  await builder.group("Signing", async () => {
    logger.info(`Signing MSI: ${unsignedPath}`)
    await sign(unsignedPath)
    await Deno.rename(unsignedPath, signedPath)
  })

  await builder.group("Uploading to GitHub Release", async () => {
    logger.info(`Uploading to dev release: ${signedPath}`)
    await uploadToDevRelease([signedPath])
  })
}
