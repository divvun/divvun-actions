import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { bundleLibreOfficeOutto } from "~/actions/divvunspell-libreoffice/bundle-outto.ts"
import { download } from "~/util/download.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { versions } from "~/docker/versions.ts"
import { resolveExtensionVersion } from "./version.ts"

const OXT_ARTIFACT = "divvunspell-libreoffice-macos.oxt"
const INSTALLER_ARTIFACT = "divvunspell-libreoffice-macos.app.zip"

export async function runLibreOfficeExtensionMacosOxt() {
  const runtimeVersion = versions.divvunRuntime
  using stage = await makeTempDir({ prefix: "divvun-runtime-lib-" })

  const archEnv: Record<string, string> = {}
  for (const arch of ["aarch64", "x86_64"] as const) {
    const targetTriple = `${arch}-apple-darwin`
    const archiveName =
      `libdivvun_runtime-${targetTriple}-v${runtimeVersion}.tar.xz`
    const url =
      `https://github.com/divvun/divvun-runtime/releases/download/v${runtimeVersion}/${archiveName}`

    await builder.group(`Downloading divvun-runtime (${arch})`, async () => {
      const archivePath = await download(url, { path: stage.path })
      await builder.exec("tar", ["-xJf", archivePath, "-C", stage.path])
    })

    archEnv[`DIVVUN_RUNTIME_LIB_${arch.toUpperCase()}`] = path.join(
      stage.path,
      `libdivvun_runtime-${targetTriple}`,
    )
  }

  const outputPath = path.resolve(OXT_ARTIFACT)

  await builder.group("Building .oxt", async () => {
    await builder.exec("./make-oxt-macos.sh", [], {
      env: { ...archEnv, OUTPUT_OXT: outputPath },
    })
  })

  await builder.group("Uploading .oxt", async () => {
    await builder.uploadArtifacts(outputPath)
  })
}

export async function runLibreOfficeExtensionMacosInstaller() {
  using tempDir = await makeTempDir({ prefix: "lo-macos-installer-" })

  await builder.group("Downloading .oxt", async () => {
    await builder.downloadArtifacts(OXT_ARTIFACT, tempDir.path)
  })

  const oxtPath = path.join(tempDir.path, OXT_ARTIFACT)
  const version = await resolveExtensionVersion()
  const appOutputPath = path.resolve(tempDir.path, "Divvun for LibreOffice.app")

  let payloadPath: string
  await builder.group("Building outto installer", async () => {
    const result = await bundleLibreOfficeOutto({
      platform: "macos",
      oxtPath,
      version,
      outputPath: appOutputPath,
    })
    payloadPath = result.payloadPath
    logger.info(`outto produced ${payloadPath}`)
  })

  await builder.group("Archiving .app", async () => {
    const archivePath = path.resolve(INSTALLER_ARTIFACT)
    await builder.exec("ditto", [
      "-c",
      "-k",
      "--keepParent",
      payloadPath!,
      archivePath,
    ])
    await builder.uploadArtifacts(archivePath)
  })
}
