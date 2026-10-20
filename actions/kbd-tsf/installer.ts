// The installer of the Divvun keyboard text service (kbdgen's crates/kbd-tsf):
// `kbdgen tsf` builds its four DLLs, which are signed and packed by outto.
// kbdgen spec: tsf.arch.builds, tsf.arch.registration, tsf.security.signing,
// tsf.register.server, tsf.register.upgrade, tsf.register.uninstall,
// tsf.installer.bundle.

import * as path from "@std/path"
import * as toml from "@std/toml"
import { makeOuttoInstaller, windowsOuttoSigning } from "~/actions/outto/lib.ts"
import * as builder from "~/builder.ts"
import sign from "~/services/windows-codesign.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { makeTempDir } from "~/util/temp.ts"

/** The release asset name, `divvun-tip_windows_<version>.exe`. */
export const TIP_NAME = "divvun-tip"
/** One installer serves x64 and Arm64 Windows. */
export const TIP_TARGET = "windows"
/** The rolling prerelease of the kbdgen repository that main's builds replace. */
export const TIP_DEV_TAG = "kbd-tsf-dev-latest"

/**
 * What tells one text service installation from another: the CLSID that
 * kbd-tsf compiles in (a test build's `KBD_TSF_CLSID`), the outto package
 * id, which names its Add/Remove Programs entry, the AppId of the Inno
 * Setup installer it replaces, and its directory under `%ProgramFiles%`. A
 * test build gives each its own value, so it never touches the real one.
 */
export type TipIdentity = {
  clsid: string
  packageId: string
  innoAppId: string
  appDir: string
}

export const TIP_IDENTITY: TipIdentity = {
  clsid: "{5E668C8A-2FB8-41D2-90B1-9C132653FA9D}",
  packageId: "no.divvun.text-service",
  innoAppId: "D75B9208-31F3-44DA-9F6F-CD1AD320E17A",
  appDir: "Divvun/Text Service",
}

/**
 * The uninstaller outto keeps in the installation's receipt, which keyboard
 * installers run (`#{pf}` is the 64-bit `%ProgramFiles%`).
 */
export function tipUninstallerPath(
  identity: TipIdentity = TIP_IDENTITY,
): string {
  return `#{pf}/${identity.appDir}/.outto/${identity.packageId}/uninstall.exe`
}

/** Silent, without message boxes or restarts. */
export const TIP_INSTALL_ARGS = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART"
/** The uninstaller never restarts, and older outto refuses `/NORESTART`. */
export const TIP_UNINSTALL_ARGS = "/VERYSILENT /SUPPRESSMSGBOXES"

/** The four PE files `kbdgen tsf` writes (tsf.security.signing). */
export const TIP_DLLS = [
  "divvun_tip_x86.dll",
  "divvun_tip_x64.dll",
  "divvun_tip_arm64.dll",
  "divvun_tip.dll",
] as const

const CRATE_MANIFEST = path.join("crates", "kbd-tsf", "Cargo.toml")
const PACKAGE_VERSION = /^(version\s*=\s*)"([^"]+)"/m

/** Whether `workspace` has the text service crate; kbdgen's main does not. */
export function hasTextService(workspace: string): boolean {
  try {
    return Deno.statSync(path.join(workspace, CRATE_MANIFEST)).isFile
  } catch {
    return false
  }
}

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
 * The outto manifest of the text service installer, for the DLLs in
 * `payloadDir`:
 *
 * - every version in its own directory, `<appDir>\<version>`, under the
 *   64-bit `%ProgramFiles%`, whose ACL the files inherit: the x86 DLL on
 *   every Windows, and the x64 DLL on x64 Windows; on Arm64 also the arm64
 *   DLL and the Arm64X forwarder (tsf.register.upgrade,
 *   tsf.security.appcontainer, tsf.arch.builds). A version directory's files
 *   never change, so an existing one stays: a loaded DLL cannot be
 *   overwritten anyway.
 * - registration with SysWOW64's regsvr32 for the x86 DLL, then System32's
 *   for the native DLL that owns the categories (tsf.arch.registration). A
 *   failure fails the install, which unregisters what it registered and
 *   leaves older versions in place.
 * - never a downgrade: the installed version is the directory that
 *   `InprocServer32` names. The same version installs again.
 * - once registered, every other version directory goes, with what is left
 *   of an Inno Setup install, which this one takes over rather than running
 *   its uninstaller: that would refuse while keyboards use it, which they
 *   always do. A loaded DLL is moved to the Windows temporary directory and
 *   deleted from there at the next restart.
 * - no closing of the processes that have the text service loaded.
 * - the uninstaller refuses while any language profile remains under the
 *   CLSID in `CTF\TIP` (tsf.register.uninstall); otherwise it unregisters
 *   the native DLL, then the x86 one, and removes the files.
 */
export function tipOuttoConfig(
  version: string,
  payloadDir: string,
  identity: TipIdentity = TIP_IDENTITY,
): OuttoBuilder {
  const versionDir = "#{app}/#{package.version}"
  const config = new OuttoBuilder(payloadDir, "windows")
    .id(identity.packageId)
    .name("Divvun Text Service")
    .version(version)
    .publisher("Divvun")
    .url("https://divvun.no/")
    .privileges("admin")
    .defaultDir(`#{pf}/${identity.appDir}`)
    .disableDirPage()
    .restartManager(false)
    .upgradePolicy("overwrite")
    .legacyInnoAppId(identity.innoAppId, "adopt")
    .refuseDowngrade({
      registry_key:
        `HKLM\\SOFTWARE\\Classes\\CLSID\\${identity.clsid}\\InprocServer32`,
      from: "parent_dir_name",
    })
    .pruneOnInstall(["#{app}"])
    .refuseUninstallWhile({
      registry_key:
        `HKLM\\SOFTWARE\\Microsoft\\CTF\\TIP\\${identity.clsid}\\LanguageProfile\\*\\*`,
      message:
        "Divvun keyboards still use the Divvun Text Service. Uninstall them first.",
    })

  const file = (source: string, arch?: "x64" | "arm64") =>
    config.file({ source, dest: versionDir, overwrite: "never", arch })
  file("divvun_tip_x86.dll")
  file("divvun_tip_x64.dll", "x64")
  file("divvun_tip_x64.dll", "arm64")
  file("divvun_tip_arm64.dll", "arm64")
  file("divvun_tip.dll", "arm64")

  config.com({
    file: `${versionDir}/divvun_tip_x86.dll`,
    action: "regserver",
    host: "x86",
  })
  config.com({
    file: `${versionDir}/divvun_tip_x64.dll`,
    action: "regserver",
    arch: "x64",
  })
  config.com({
    file: `${versionDir}/divvun_tip_arm64.dll`,
    action: "regserver",
    arch: "arm64",
  })
  return config
}

/**
 * Builds the text service installer at `outputPath` from the directory
 * holding the four DLLs. Signing signs the installer and the uninstaller it
 * carries through `divvun-actions sign`, as the keyboard installers do.
 */
export async function buildTipInstaller(opts: {
  version: string
  payloadDir: string
  outputPath: string
  sign: boolean
  identity?: TipIdentity
}): Promise<string> {
  using configDir = await makeTempDir({ prefix: "divvun-tip-outto-" })
  const configPath = path.join(configDir.path, "outto.toml")
  const config = tipOuttoConfig(opts.version, opts.payloadDir, opts.identity)
  logger.info(`Text service outto manifest:\n${config.build()}`)
  await config.write(configPath)
  const signing = opts.sign
    ? windowsOuttoSigning(
      path.join(target.projectPath, "bin", "divvun-actions.bat"),
    )
    : {}
  const result = await makeOuttoInstaller({
    configPath,
    sourceDir: path.resolve(opts.payloadDir),
    outputPath: path.resolve(opts.outputPath),
    target: "windows",
    ...signing,
  })
  return result.path
}
