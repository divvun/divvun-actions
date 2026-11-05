import * as path from "@std/path"
import logger from "~/util/log.ts"
import { isMatchingTag, Kbdgen } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import {
  buildKeyboardMacOSOutto,
  buildKeyboardWindowsOutto,
  type OuttoKeyboardResult,
} from "./outto.ts"
import { KeyboardType } from "../types.ts"
import {
  loadWindowsLayouts,
  signLayoutDlls,
  stageInstallerPayload,
} from "./layouts.ts"
import { NIGHTLY_CHANNEL } from "../../version.ts"
import {
  type KeyboardToolchainKind,
  prepareWindowsToolchain,
} from "./toolchain.ts"

// Taken straight from semver.org, with added 'v'
const SEMVER_TAG_RE =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export type Props = {
  keyboardType: KeyboardType
  bundlePath: string
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

  const platform = keyboardType === KeyboardType.MacOS ? "macos" : "windows"
  const channel = await determineVersionAndChannel(
    bundlePath,
    platform,
  )

  let payloadPath: string
  let unsigned = false

  if (keyboardType === KeyboardType.MacOS) {
    const generatedBundleDir = await Kbdgen.buildMacOS(bundlePath)
    const result = await buildKeyboardMacOSOutto({
      bundlePath,
      generatedBundleDir,
      outputDir: path.dirname(generatedBundleDir),
    })
    payloadPath = result.path
    unsigned = result.unsigned
  } else {
    const result = await buildWindowsKeyboard(bundlePath, toolchain)
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
  toolchainKind: KeyboardToolchainKind,
): Promise<OuttoKeyboardResult> {
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
    await signLayoutDlls(payloadDir, layouts)
  } else {
    payloadDir = outputPath
    await copyKbdiExecutables(toolchain.kbdiBinDir, outputPath)
    await createArchitectureDirectories(outputPath)
  }

  logger.debug("Creating Windows installer via outto")
  return await buildKeyboardWindowsOutto(
    bundlePath,
    payloadDir,
    outputPath,
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
  logger.debug("Creating the i386, amd64 and wow64 payload directories")

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
