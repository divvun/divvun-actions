import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { bundleLibreOfficeOutto } from "~/actions/divvunspell-libreoffice/bundle-outto.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { execWithMsvcEnv, msvcArchFor } from "~/util/msvc-env.ts"
import { resolveExtensionVersion } from "./version.ts"
import { downloadDivvunRuntimeLib } from "./runtime-dep.ts"

export type WindowsArch = "x86_64" | "aarch64"

const ARCHS: WindowsArch[] = ["x86_64", "aarch64"]

export function isWindowsArch(value: string): value is WindowsArch {
  return (ARCHS as string[]).includes(value)
}

function targetTriple(arch: WindowsArch): string {
  return `${arch}-pc-windows-msvc`
}

function oxtArtifact(arch: WindowsArch): string {
  return `divvunspell-libreoffice-windows-${arch}.oxt`
}

function installerArtifact(arch: WindowsArch): string {
  return `divvunspell-libreoffice-windows-${arch}.exe`
}

export async function runLibreOfficeExtensionWindowsOxt(arch: WindowsArch) {
  const target = targetTriple(arch)
  using stage = await makeTempDir({ prefix: "divvun-runtime-lib-" })

  await builder.group("Downloading divvun-runtime lib", async () => {
    const archivePath = await downloadDivvunRuntimeLib(target, stage.path)
    await builder.exec("bsdtar", ["-xJf", archivePath, "-C", stage.path])
  })

  const extracted = path.join(stage.path, `libdivvun_runtime-${target}`)

  // Surface what's actually in the archive so build failures upstream of us
  // (e.g. missing staticlib) are debuggable from the .oxt build log.
  await builder.group("Inspecting extracted lib", async () => {
    for await (const entry of Deno.readDir(path.join(extracted, "lib"))) {
      logger.info(`lib/${entry.name}`)
    }
  })

  await builder.group("Building .oxt", async () => {
    await execWithMsvcEnv(msvcArchFor(target), "./make-oxt-windows.ps1", {
      env: {
        RUNTIME_LIB: path.join(extracted, "lib"),
        RUNTIME_INC: path.join(extracted, "include"),
      },
    })
  })

  await builder.group("Uploading .oxt", async () => {
    await Deno.rename("windows.oxt", oxtArtifact(arch))
    await builder.uploadArtifacts(oxtArtifact(arch))
  })
}

export async function runLibreOfficeExtensionWindowsInstaller(
  arch: WindowsArch,
) {
  using tempDir = await makeTempDir({ prefix: "lo-win-installer-" })

  const oxtName = oxtArtifact(arch)
  await builder.group("Downloading .oxt", async () => {
    await builder.downloadArtifacts(oxtName, tempDir.path)
  })

  const oxtPath = path.join(tempDir.path, oxtName)
  const version = await resolveExtensionVersion()
  const requestedPath = path.resolve(installerArtifact(arch))

  let producedPath: string
  await builder.group("Building outto installer", async () => {
    const result = await bundleLibreOfficeOutto({
      platform: "windows",
      oxtPath,
      version,
      outputPath: requestedPath,
    })
    producedPath = result.payloadPath
    if (result.unsigned) {
      logger.warning(
        `outto produced an UNSIGNED installer at ${producedPath} — signing failed and was bypassed`,
      )
    } else {
      logger.info(`outto produced ${producedPath}`)
    }
  })

  await builder.group("Uploading installer", async () => {
    await builder.uploadArtifacts(producedPath!)
  })
}
