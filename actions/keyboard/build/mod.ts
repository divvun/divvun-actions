import * as path from "@std/path"
import logger from "~/util/log.ts"
import { isMatchingTag, Kbdgen, PahkatPrefix } from "~/util/shared.ts"
import { makeInstaller } from "../../inno-setup/lib.ts"
import { KeyboardType } from "../types.ts"
import { generateKbdInnoFromBundle } from "./iss.ts"
import { NIGHTLY_CHANNEL } from "../../version.ts"

// Taken straight from semver.org, with added 'v'
const SEMVER_TAG_RE =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export type Props = {
  keyboardType: KeyboardType
  bundlePath: string
}

export type Output = {
  channel: string | null
  payloadPath: string
}

export default async function keyboardBuild({
  keyboardType,
  bundlePath,
}: Props): Promise<Output> {
  if (
    keyboardType !== KeyboardType.Windows &&
    keyboardType !== KeyboardType.MacOS
  ) {
    throw new Error(
      `Unsupported keyboard type for non-meta build: ${keyboardType}`,
    )
  }

  const platform = keyboardType === KeyboardType.MacOS ? "macos" : "windows"
  const channel = await determineVersionAndChannel(
    bundlePath,
    platform,
  )

  const payloadPath = keyboardType === KeyboardType.MacOS
    ? await Kbdgen.buildMacOS(bundlePath)
    : await buildWindowsKeyboard(bundlePath)

  return {
    payloadPath,
    channel,
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

async function buildWindowsKeyboard(bundlePath: string): Promise<string> {
  await setupWindowsDependencies()

  logger.debug("Building Windows keyboard")
  const outputPath = await Kbdgen.buildWindows(bundlePath)
  logger.debug("Windows keyboard built")

  await copyKbdiExecutables(outputPath)
  await createArchitectureDirectories(outputPath)

  return await createWindowsInstaller(bundlePath, outputPath)
}

async function setupWindowsDependencies(): Promise<void> {
  await PahkatPrefix.bootstrap(["devtools"], "nightly")
  logger.debug("Installing kbdi")
  await PahkatPrefix.install(["kbdi", "kbdgen"])
  logger.debug("Installed kbdi")
}

async function copyKbdiExecutables(outputPath: string): Promise<void> {
  const kbdi_path = path.join(
    PahkatPrefix.path,
    "pkg",
    "kbdi",
    "bin",
    "kbdi.exe",
  )
  const kbdi_x64_path = path.join(
    PahkatPrefix.path,
    "pkg",
    "kbdi",
    "bin",
    "kbdi-x64.exe",
  )

  await Deno.copyFile(kbdi_path, path.resolve(outputPath, "kbdi.exe"))
  await Deno.copyFile(kbdi_x64_path, path.resolve(outputPath, "kbdi-x64.exe"))
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
  outputPath: string,
): Promise<string> {
  logger.debug("Generating Inno Setup script")
  const issPath = await generateKbdInnoFromBundle(bundlePath, outputPath)

  logger.debug("Creating Windows installer")
  const installerPath = await makeInstaller(issPath)
  logger.debug("Installer created")

  return installerPath
}
