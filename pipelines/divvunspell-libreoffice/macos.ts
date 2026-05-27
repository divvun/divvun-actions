import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { bundleLibreOfficeOutto } from "~/actions/divvunspell-libreoffice/bundle-outto.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { resolveExtensionVersion } from "./version.ts"
import { downloadDivvunRuntimeLib } from "./runtime-dep.ts"

const OXT_ARTIFACT = "divvunspell-libreoffice-macos.oxt"
const INSTALLER_ARTIFACT = "divvunspell-libreoffice-macos.app.zip"

export async function runLibreOfficeExtensionMacosOxt() {
  const target = "aarch64-apple-darwin"
  using stage = await makeTempDir({ prefix: "divvun-runtime-lib-" })

  await builder.group("Downloading divvun-runtime lib", async () => {
    const archivePath = await downloadDivvunRuntimeLib(target, stage.path)
    await builder.exec("tar", ["-xJf", archivePath, "-C", stage.path])
  })

  const extracted = path.join(stage.path, `libdivvun_runtime-${target}`)
  const fakeRuntimeDir = await buildFakeRuntimeDir(stage.path)

  await builder.group("Building .oxt", async () => {
    await builder.exec("./make-oxt-macos.sh", [], {
      env: {
        DIVVUN_RUNTIME_DIR: fakeRuntimeDir,
        RUNTIME_LIB: path.join(extracted, "lib"),
        RUNTIME_INC: path.join(extracted, "include"),
      },
    })
  })

  await builder.group("Uploading .oxt", async () => {
    await Deno.rename("macos.oxt", OXT_ARTIFACT)
    await builder.uploadArtifacts(OXT_ARTIFACT)
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

// The outer make-oxt-*.sh scripts always invoke `$DIVVUN_RUNTIME_DIR/x
// build-lib` even when RUNTIME_LIB is overridden, so we need a directory with
// an executable `x` stub that exits 0 to satisfy the script's preflight.
async function buildFakeRuntimeDir(stageRoot: string): Promise<string> {
  const dir = path.join(stageRoot, "divvun-runtime-stub")
  await Deno.mkdir(dir, { recursive: true })
  const xPath = path.join(dir, "x")
  await Deno.writeTextFile(xPath, "#!/bin/sh\nexit 0\n")
  await Deno.chmod(xPath, 0o755)
  return dir
}
