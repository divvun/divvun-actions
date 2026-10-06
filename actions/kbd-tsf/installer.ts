// The installer of the Divvun keyboard text service (kbdgen's crates/kbd-tsf):
// `kbdgen tsf` builds its four DLLs, which are signed and packed by
// divvun-tip.iss. kbdgen spec: tsf.arch.builds, tsf.security.signing,
// tsf.register.upgrade.

import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import sign from "~/services/windows-codesign.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"

/** The release asset name, `divvun-tip_windows_<version>.exe`. */
export const TIP_NAME = "divvun-tip"
/** One installer serves x86, x64 and Arm64 Windows. */
export const TIP_TARGET = "windows"
/**
 * The rolling prerelease of the kbdgen repository that main's builds
 * replace, and that keyboard builds embed.
 */
export const TIP_DEV_TAG = "kbd-tsf-dev-latest"

/**
 * Where divvun-tip.iss installs the text service: `{commonpf}\Divvun\Text
 * Service`, one directory per version, and its Inno uninstaller beside them.
 * Keyboard installers run the uninstaller from here.
 */
export const TIP_APP_DIR = "Divvun\\Text Service"
export const TIP_UNINSTALLER = "unins000.exe"

/** Silent, without message boxes or restarts, for both setup and uninstaller. */
export const TIP_SILENT_ARGS = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"

/** The four PE files `kbdgen tsf` writes (tsf.security.signing). */
export const TIP_DLLS = [
  "divvun_tip_x86.dll",
  "divvun_tip_x64.dll",
  "divvun_tip_arm64.dll",
  "divvun_tip.dll",
] as const

const CRATE_MANIFEST = path.join("crates", "kbd-tsf", "Cargo.toml")
const PACKAGE_VERSION = /^(version\s*=\s*)"([^"]+)"/m

/** The `kbd-tsf` package version, which names the install directory. */
export async function readTipVersion(workspace: string): Promise<string> {
  const manifest = toml.parse(
    await Deno.readTextFile(path.join(workspace, CRATE_MANIFEST)),
  ) as { package?: { version?: unknown } }
  const version = manifest.package?.version
  if (typeof version !== "string") {
    throw new Error(`${CRATE_MANIFEST} has no literal package version`)
  }
  return version
}

/**
 * Sets the `kbd-tsf` package version, which DllRegisterServer compiles in and
 * insists its directory is named after. Each development build needs its own
 * version: two builds sharing one would share a directory, and a loaded DLL
 * there cannot be replaced (tsf.register.upgrade).
 */
export async function setTipVersion(
  workspace: string,
  version: string,
): Promise<void> {
  const file = path.join(workspace, CRATE_MANIFEST)
  const text = await Deno.readTextFile(file)
  if (!PACKAGE_VERSION.test(text)) {
    throw new Error(`${CRATE_MANIFEST} has no version line`)
  }
  await Deno.writeTextFile(
    file,
    text.replace(PACKAGE_VERSION, (_, key) => `${key}"${version}"`),
  )
}

/**
 * Runs `kbdgen tsf`, which needs Windows with MSVC and the Rust targets of
 * all three architectures, and returns the four DLLs it printed. kbdgen
 * prints each path on its own line on stdout, among its log lines.
 */
export async function buildTipDlls(
  kbdgen: string,
  workspace: string,
  outputDir: string,
): Promise<string[]> {
  const { stdout, stderr, status } = await builder.output(kbdgen, [
    "tsf",
    "--workspace",
    workspace,
    "--output-path",
    outputDir,
  ])
  if (!status.success) {
    throw new Error(
      `kbdgen tsf failed (exit ${status.code}):\n${stderr}\n${stdout}`,
    )
  }
  const printed = stdout.split(/\r?\n/).map((line) => line.trim())
  const dlls: string[] = []
  for (const name of TIP_DLLS) {
    const file = printed.find((line) =>
      path.isAbsolute(line) && path.basename(line).toLowerCase() === name
    )
    if (!file) {
      throw new Error(`kbdgen tsf did not print ${name}:\n${stdout}`)
    }
    dlls.push(file)
  }
  return dlls
}

/** Signs each text service PE file in place (tsf.security.signing). */
export async function signTipDlls(dlls: string[]): Promise<void> {
  for (const dll of dlls) {
    logger.info(`Signing ${dll}`)
    await sign(dll)
  }
}

/**
 * Compiles divvun-tip.iss into `<outputDir>/<baseName>.exe` from the
 * directory holding the four DLLs. Signing signs the installer and its
 * uninstaller through `divvun-actions sign`, as the keyboard installers do.
 */
export async function compileTipInstaller(opts: {
  version: string
  payloadDir: string
  outputDir: string
  baseName: string
  sign: boolean
}): Promise<string> {
  const script = path.join(import.meta.dirname ?? "", "divvun-tip.iss")
  const args = [
    `/DTipVersion=${opts.version}`,
    `/DPayloadDir=${path.resolve(opts.payloadDir)}`,
    `/DOutputBaseFilename=${opts.baseName}`,
    `/O${path.resolve(opts.outputDir)}`,
  ]
  if (opts.sign) {
    const signer = path.join(target.projectPath, "bin", "divvun-actions.bat")
    args.push("/DSign", `/Ssigntool=$q${signer}$q sign $f`)
  }
  args.push(script)
  await builder.exec("iscc.exe", args)
  return path.join(opts.outputDir, `${opts.baseName}.exe`)
}
