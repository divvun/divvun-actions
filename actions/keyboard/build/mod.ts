import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { isMatchingTag, Kbdgen, PahkatPrefix } from "~/util/shared.ts"
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
}: Props): Promise<Output> {
  if (
    keyboardType !== KeyboardType.Windows &&
    keyboardType !== KeyboardType.MacOS
  ) {
    throw new Error(
      `Unsupported keyboard type for non-meta build: ${keyboardType}`,
    )
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
    const result = await buildWindowsKeyboard(bundlePath, installerKind)
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
): Promise<InstallerResult> {
  await setupWindowsDependencies()
  await checkLayoutDllToolchain()

  logger.debug("Building Windows keyboard")
  const outputPath = await Kbdgen.buildWindows(bundlePath)
  logger.debug("Windows keyboard built")

  const layouts = await loadWindowsLayouts(bundlePath)
  const payloadDir = path.join(outputPath, "installer-payload")
  await Deno.remove(payloadDir, { recursive: true }).catch((e) => {
    if (!(e instanceof Deno.errors.NotFound)) throw e
  })
  await stageInstallerPayload({
    kbdgenOutput: outputPath,
    kbdiBinDir: path.join(PahkatPrefix.path, "pkg", "kbdi", "bin"),
    payloadDir,
    layouts,
  })

  if (installerKind === "outto") {
    logger.debug("Creating Windows installer via outto")
    return await buildKeyboardWindowsOutto(
      bundlePath,
      payloadDir,
      outputPath,
      layouts,
    )
  }

  return await createWindowsInstaller(bundlePath, payloadDir, layouts)
}

async function setupWindowsDependencies(): Promise<void> {
  await PahkatPrefix.bootstrap(["devtools"], "nightly")
  logger.debug("Installing kbdi")
  await PahkatPrefix.install(["kbdi", "kbdgen"])
  logger.debug("Installed kbdi")
}

/** The Rust targets kbdgen builds layout DLLs for (`kbdl.build`). */
const LAYOUT_DLL_TARGETS = [
  "i686-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
]

/**
 * kbdgen builds the layout DLLs itself with cargo and rust-lld, and fails
 * without a Rust toolchain that has all of LAYOUT_DLL_TARGETS
 * (`kbdl.build.toolchain`). Check up front so a build agent that lacks one
 * fails with the fix for the agent image, not deep inside kbdgen.
 */
async function checkLayoutDllToolchain(): Promise<void> {
  const run = async (args: string[]) => {
    try {
      const { stdout, stderr, status } = await builder.output("rustc", args)
      return status.success
        ? { ok: true, text: stdout.trim() }
        : { ok: false, text: stderr.trim() }
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) }
    }
  }

  const version = await run(["--version"])
  if (!version.ok) {
    throw new Error(
      `kbdgen needs a Rust toolchain to build Windows layout DLLs, but ` +
        `rustc does not run: ${version.text}. Install Rust with rustup ` +
        `on the Windows build agent (docker/images/windows.ts).`,
    )
  }
  logger.info(`Layout DLL toolchain: ${version.text}`)

  const missing: string[] = []
  for (const triple of LAYOUT_DLL_TARGETS) {
    const libdir = await run(["--print", "target-libdir", "--target", triple])
    if (!libdir.ok || !await isDirectory(libdir.text)) {
      missing.push(triple)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `kbdgen builds Windows layout DLLs for ${
        LAYOUT_DLL_TARGETS.join(", ")
      }, but this Rust toolchain lacks ${missing.join(", ")}. ` +
        `Run \`rustup target add ${missing.join(" ")}\`, or add them to ` +
        `the rust() tool's targets in docker/images/windows.ts.`,
    )
  }
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await Deno.stat(dirPath)).isDirectory
  } catch {
    return false
  }
}

async function createWindowsInstaller(
  bundlePath: string,
  payloadDir: string,
  layouts: WindowsLayout[],
): Promise<InstallerResult> {
  await stageWindInstaller(payloadDir)
  await stageTipInstaller(payloadDir)

  logger.debug("Generating Inno Setup script")
  const issPath = await generateKbdInnoFromBundle(
    bundlePath,
    payloadDir,
    layouts,
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
