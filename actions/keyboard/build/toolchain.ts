// The kbdgen and kbdi a Windows keyboard build runs, and with them what its
// installers ship.

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import {
  KBDGEN_NAME,
  KBDGEN_REPO,
  KBDGEN_V4_TAG,
  KBDGEN_WINDOWS_TARGET,
} from "~/actions/kbdgen/v4.ts"
import sign from "~/services/windows-codesign.ts"
import { assetGhPattern, assetPsPattern } from "~/util/asset_name.ts"
import logger from "~/util/log.ts"
import { PahkatPrefix } from "~/util/shared.ts"
import { downloadVerifiedReleaseAsset } from "./release_asset.ts"
import { downloadTipInstaller } from "./tip.ts"

/**
 * `production`: kbdgen and kbdi from pahkat's nightly devtools. kbdgen builds
 * `x86` and `x64` layout DLLs, which the installers ship as `i386`, `amd64`
 * and `wow64`.
 *
 * `v4`: kbdgen and the text service installer from the KBDGEN_V4_TAG
 * prerelease, and kbdi built from KBDI_V4_BRANCH. kbdgen builds its own
 * layout DLLs for every LAYOUT_DLL_VARIANTS entry and reads format 4
 * bundles; the installers embed the text service.
 */
export type KeyboardToolchainKind = "production" | "v4"

export type KeyboardToolchain =
  | {
    kind: "production"
    kbdgen: string
    /** Holds `kbdi.exe` (x86) and `kbdi-x64.exe`. */
    kbdiBinDir: string
  }
  | {
    kind: "v4"
    kbdgen: string
    kbdiBinDir: string
    /** The verified text service installer the keyboard installers embed. */
    tipInstaller: string
  }

/** kbdi with text service profiles (`kbdi keyboard_install` registering them). */
const KBDI_REPO = "https://github.com/divvun/kbdi.git"
export const KBDI_V4_BRANCH = "kbdgen-tsf-profiles"

/** kbdi.exe runs on x86 Windows, kbdi-x64.exe in 64-bit install mode. */
const KBDI_BUILDS = [
  { triple: "i686-pc-windows-msvc", name: "kbdi.exe" },
  { triple: "x86_64-pc-windows-msvc", name: "kbdi-x64.exe" },
]

/** The Rust targets kbdgen builds layout DLLs for (`kbdl.build`). */
const LAYOUT_DLL_TARGETS = [
  "i686-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
]

/**
 * Installs or downloads the `kind` toolchain. A v4 toolchain lives in
 * `workDir`, which must outlive the build.
 */
export async function prepareWindowsToolchain(
  kind: KeyboardToolchainKind,
  workDir: string,
): Promise<KeyboardToolchain> {
  if (kind === "production") {
    await PahkatPrefix.bootstrap(["devtools"], "nightly")
    logger.debug("Installing kbdi")
    await PahkatPrefix.install(["kbdi", "kbdgen"])
    logger.debug("Installed kbdi")
    return {
      kind,
      kbdgen: "kbdgen",
      kbdiBinDir: path.join(PahkatPrefix.path, "pkg", "kbdi", "bin"),
    }
  }

  await checkLayoutDllToolchain()
  const kbdgenDir = path.join(workDir, "kbdgen")
  const tipDir = path.join(workDir, "tip")
  await Deno.mkdir(kbdgenDir)
  await Deno.mkdir(tipDir)
  const kbdgen = await downloadVerifiedReleaseAsset({
    repo: KBDGEN_REPO,
    tag: KBDGEN_V4_TAG,
    ghPattern: assetGhPattern(KBDGEN_NAME, KBDGEN_WINDOWS_TARGET, "exe"),
    pattern: new RegExp(
      assetPsPattern(KBDGEN_NAME, KBDGEN_WINDOWS_TARGET, "exe"),
    ),
    label: "kbdgen",
    directory: kbdgenDir,
  })
  await builder.exec(kbdgen, ["-V"])
  return {
    kind,
    kbdgen,
    kbdiBinDir: await buildKbdi(workDir),
    tipInstaller: await downloadTipInstaller(KBDGEN_V4_TAG, tipDir),
  }
}

/**
 * Builds and signs kbdi from KBDI_V4_BRANCH into `<workDir>/kbdi-bin`. Its
 * rust-toolchain.toml pins the toolchain and its targets, which rustup
 * installs.
 */
async function buildKbdi(workDir: string): Promise<string> {
  const source = path.join(workDir, "kbdi")
  await builder.exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    KBDI_V4_BRANCH,
    KBDI_REPO,
    source,
  ])
  const { stdout } = await builder.output("git", ["rev-parse", "HEAD"], {
    cwd: source,
  })
  logger.info(`Building kbdi ${KBDI_V4_BRANCH} at ${stdout.trim()}`)
  await builder.exec("rustup", ["toolchain", "install"], { cwd: source })

  const binDir = path.join(workDir, "kbdi-bin")
  await Deno.mkdir(binDir)
  for (const { triple, name } of KBDI_BUILDS) {
    await builder.exec("cargo", [
      "build",
      "--release",
      "--locked",
      "--bin",
      "kbdi",
      "--target",
      triple,
    ], { cwd: source })
    const binary = path.join(binDir, name)
    await Deno.copyFile(
      path.join(source, "target", triple, "release", "kbdi.exe"),
      binary,
    )
    await sign(binary)
  }
  return binDir
}

/**
 * kbdgen v4 builds the layout DLLs itself with cargo and rust-lld, and fails
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
