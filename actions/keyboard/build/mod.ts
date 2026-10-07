import * as path from "@std/path"
import logger from "~/util/log.ts"
import { isMatchingTag, Kbdgen } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import { type InstallerResult, makeInstaller } from "../../inno-setup/lib.ts"
import { buildKeyboardMacOSOutto, buildKeyboardWindowsOutto } from "./outto.ts"
import { KeyboardType } from "../types.ts"
import { generateKbdInnoFromBundle } from "./iss.ts"
import {
  loadWindowsLayouts,
  stageInstallerPayload,
  type WindowsLayout,
} from "./layouts.ts"
import { NIGHTLY_CHANNEL } from "../../version.ts"
import { stageTipInstaller } from "./tip.ts"
import {
  type KeyboardToolchain,
  type KeyboardToolchainKind,
  prepareWindowsToolchain,
} from "./toolchain.ts"
import { stageWindInstaller } from "./wind.ts"

// Taken straight from semver.org, with added 'v'
const SEMVER_TAG_RE =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** Selects which installer toolchain to use. */
export type InstallerKind = "legacy" | "outto"

function resolveInstallerKind(explicit?: InstallerKind): InstallerKind {
  if (explicit) return explicit
  const env = Deno.env.get("DIVVUN_INSTALLER")
  if (env === "outto" || env === "legacy") return env
  return "legacy"
}

export type Props = {
  keyboardType: KeyboardType
  bundlePath: string
  /** Installer toolchain. Defaults to env DIVVUN_INSTALLER, else "legacy". */
  installer?: InstallerKind
  /** The kbdgen and kbdi a Windows build uses. Defaults to "production". */
  toolchain?: KeyboardToolchainKind
}

export type Output = {
  channel: string | null
  payloadPath: string
  unsigned: boolean
}

export default async function keyboardBuild({
  keyboardType,
  bundlePath,
  installer,
  toolchain = "production",
}: Props): Promise<Output> {
  if (
    keyboardType !== KeyboardType.Windows &&
    keyboardType !== KeyboardType.MacOS
  ) {
    throw new Error(
      `Unsupported keyboard type for non-meta build: ${keyboardType}`,
    )
  }
  if (toolchain !== "production" && keyboardType !== KeyboardType.Windows) {
    throw new Error(`The ${toolchain} toolchain only builds Windows keyboards`)
  }

  const installerKind = resolveInstallerKind(installer)
  const platform = keyboardType === KeyboardType.MacOS ? "macos" : "windows"
  const channel = await determineVersionAndChannel(
    bundlePath,
    platform,
  )

  let payloadPath: string
  let unsigned = false

  if (keyboardType === KeyboardType.MacOS) {
    if (installerKind === "outto") {
      const generatedBundleDir = await Kbdgen.buildMacOS(bundlePath, {
        noInstaller: true,
      })
      const result = await buildKeyboardMacOSOutto({
        bundlePath,
        generatedBundleDir,
        outputDir: path.dirname(generatedBundleDir),
      })
      payloadPath = result.path
      unsigned = result.unsigned
    } else {
      payloadPath = await Kbdgen.buildMacOS(bundlePath)
    }
  } else {
    const result = await buildWindowsKeyboard(
      bundlePath,
      installerKind,
      toolchain,
    )
    payloadPath = result.path
    unsigned = result.unsigned
  }

  return {
    payloadPath,
    channel,
    unsigned,
  }
}

async function determineVersionAndChannel(
  bundlePath: string,
  platform: string,
): Promise<string | null> {
  if (isMatchingTag(SEMVER_TAG_RE)) {
    logger.debug("Using version from kbdgen project")
    return null // no channel for releases
  } else {
    logger.debug("Setting current version to nightly version")
    await Kbdgen.setNightlyVersion(bundlePath, platform)
    return NIGHTLY_CHANNEL
  }
}

async function buildWindowsKeyboard(
  bundlePath: string,
  installerKind: InstallerKind,
  toolchainKind: KeyboardToolchainKind,
): Promise<InstallerResult> {
  using work = await makeTempDir({ prefix: "keyboard-toolchain-" })
  const toolchain = await prepareWindowsToolchain(toolchainKind, work.path)

  logger.debug("Building Windows keyboard")
  const outputPath = await Kbdgen.buildWindows(bundlePath, toolchain.kbdgen)
  logger.debug("Windows keyboard built")

  const layouts = await loadWindowsLayouts(bundlePath)
  let payloadDir: string
  if (toolchain.kind === "v4") {
    payloadDir = path.join(outputPath, "installer-payload")
    await Deno.remove(payloadDir, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e
    })
    await stageInstallerPayload({
      kbdgenOutput: outputPath,
      kbdiBinDir: toolchain.kbdiBinDir,
      payloadDir,
      layouts,
    })
  } else {
    payloadDir = outputPath
    await copyKbdiExecutables(toolchain.kbdiBinDir, outputPath)
    await createArchitectureDirectories(outputPath)
  }

  if (installerKind === "outto") {
    logger.debug("Creating Windows installer via outto")
    return await buildKeyboardWindowsOutto(
      bundlePath,
      payloadDir,
      outputPath,
      layouts,
      toolchain,
    )
  }

  return await createWindowsInstaller(
    bundlePath,
    payloadDir,
    layouts,
    toolchain,
  )
}

async function copyKbdiExecutables(
  kbdiBinDir: string,
  outputPath: string,
): Promise<void> {
  for (const name of ["kbdi.exe", "kbdi-x64.exe"]) {
    await Deno.copyFile(
      path.join(kbdiBinDir, name),
      path.resolve(outputPath, name),
    )
  }
}

async function createArchitectureDirectories(
  outputPath: string,
): Promise<void> {
  logger.debug("Creating old-style directory structure for Inno Setup")

  const architectureMappings = [
    { from: "x86", to: "i386" },
    { from: "x64", to: "amd64" },
    { from: "x86", to: "wow64" }, // x86 files also used for wow64
  ]

  for (const mapping of architectureMappings) {
    await copyArchitectureDirectory(outputPath, mapping.from, mapping.to)
  }
}

async function copyArchitectureDirectory(
  outputPath: string,
  from: string,
  to: string,
): Promise<void> {
  const fromDir = path.join(outputPath, from)
  const toDir = path.join(outputPath, to)

  try {
    const stat = await Deno.stat(fromDir)
    if (stat.isDirectory) {
      logger.debug(`Copying ${fromDir} to ${toDir}`)
      await Deno.mkdir(toDir, { recursive: true })

      for await (const entry of Deno.readDir(fromDir)) {
        if (entry.isFile) {
          await Deno.copyFile(
            path.join(fromDir, entry.name),
            path.join(toDir, entry.name),
          )
        }
      }
    }
  } catch (e) {
    logger.debug(
      `Warning: Could not process ${from} -> ${to}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
  }
}

async function createWindowsInstaller(
  bundlePath: string,
  payloadDir: string,
  layouts: WindowsLayout[],
  toolchain: KeyboardToolchain,
): Promise<InstallerResult> {
  await stageWindInstaller(payloadDir)
  if (toolchain.kind === "v4") {
    await stageTipInstaller(payloadDir, toolchain.tipInstaller)
  }

  logger.debug("Generating Inno Setup script")
  const issPath = await generateKbdInnoFromBundle(
    bundlePath,
    payloadDir,
    layouts,
    toolchain,
  )

  logger.debug("Creating Windows installer")
  let result: InstallerResult
  try {
    result = await makeInstaller(issPath)
    logger.debug("Installer created")
  } catch (error) {
    logger.warning(
      `Signing failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    logger.warning("Retrying without code signing...")
    result = await makeInstaller(issPath, { skipSigning: true })
    logger.debug("Unsigned installer created")
  }

  return result
}
