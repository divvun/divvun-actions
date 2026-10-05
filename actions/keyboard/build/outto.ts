// Keyboard installer build path that uses outto instead of Inno Setup
// (Windows) / pkgbuild+productbuild (macOS).
//
// Opt-in: callers select this path via the `installer: "outto"` flag on
// keyboardBuild() (see ./mod.ts). Until the matching Pahkat upload type
// lands, this path stops at "signed artifact written to disk".

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeOuttoInstaller, windowsOuttoSigning } from "~/actions/outto/lib.ts"
import macosSign from "~/services/macos-codesign.ts"
import * as target from "~/target.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { Kbdgen } from "~/util/shared.ts"
import logger from "~/util/log.ts"
import type { WindowsLayout } from "./layouts.ts"
import { addWindToOutto, stageWindInstaller } from "./wind.ts"

export type OuttoKeyboardResult = {
  path: string
  unsigned: boolean
}

/**
 * Generate an outto manifest + run `outto build` for a kbdgen Windows
 * keyboard bundle. Mirrors generateKbdInnoFromBundle().
 *
 * `payloadDir` is the directory staged by `stageInstallerPayload`; outto
 * packs all of it, so the manifest and the installer go to `outputDir`.
 *
 * The package is x64-only. outto's installer stub is an x86_64 binary, and
 * its Windows architecture selectors are `x86` (which also matches x64),
 * `x64` and `any`: it has none for Arm64, where it would skip every
 * x86/x64 file but still run kbdi. Refusing Arm64 up front beats a
 * half-installed keyboard; kbdgen spec tsf.installer.layout-dlls requires
 * Arm64 (`arm64/*.dll` to `#{sys}`, `wow64/*.dll` to SysWOW64, as the Inno
 * installer does), which needs an `arm64` selector in outto first.
 */
export async function buildKeyboardWindowsOutto(
  bundlePath: string,
  payloadDir: string,
  outputDir: string,
  layouts: WindowsLayout[],
  options: { sign?: boolean } = {},
): Promise<OuttoKeyboardResult> {
  const bundle = await Kbdgen.loadTarget(bundlePath, "windows")
  const project = await Kbdgen.loadProjectBundle(bundlePath)

  const oBuilder = new OuttoBuilder(payloadDir, "windows")
    .id(`{${bundle.uuid}}`)
    .name(bundle.appName)
    .version(bundle.version)
    .publisher(project.organisation)
    .url(bundle.url)
    .privileges("admin")
    .architecture("x64")
    .defaultDir(`#{pf}/${bundle.appName}`)

  // Renamed so the run hooks can reference a single name.
  oBuilder.file({
    source: "kbdi-x64.exe",
    dest: "#{app}",
    dest_name: "kbdi.exe",
    overwrite: "always",
  })

  // kbdgen spec tsf.installer.layout-dlls; see LAYOUT_DLL_VARIANTS. The x86
  // DLL has no place here: outto cannot run on x86 Windows.
  oBuilder.file({
    source: "x64/*.dll",
    dest: "#{sys}",
    arch: "x64",
    overwrite: "always",
  })
  oBuilder.file({
    source: "wow64/*.dll",
    dest: "#{win}/SysWOW64",
    overwrite: "always",
  })

  const enableCommands: string[] = []
  for (const layout of layouts) {
    enableCommands.push(addLayoutToOuttoManifest(oBuilder, layout))
  }
  // Register the whole bundle before enabling any layout. If kbdi detects a
  // stale ctfmon cache on the first enable, one refresh sees every new Layout
  // Id; subsequent enables can verify the live profiles without another restart.
  // Separate install/enable commands also work with older kbdi payloads.
  for (const arguments_ of enableCommands) {
    oBuilder.run({
      phase: "after_install",
      command: "#{app}/kbdi.exe",
      arguments: arguments_,
      wait: true,
      show: "hidden",
    })
  }

  await stageWindInstaller(payloadDir)
  addWindToOutto(oBuilder)

  // Last of all, restart ctfmon so running apps pick up the new layouts.
  // taskkill exits non-zero when ctfmon isn't running; outto only logs that.
  // The installer is elevated, so starting ctfmon.exe directly would leave an
  // elevated ctfmon behind. The MsCtfMonitor task, which Windows itself uses
  // at sign-in, starts it as the signed-in user instead.
  oBuilder.run({
    phase: "after_install",
    command: "#{sys}/taskkill.exe",
    arguments: "/F /IM ctfmon.exe",
    wait: true,
    show: "hidden",
  })
  oBuilder.run({
    phase: "after_install",
    command: "#{sys}/schtasks.exe",
    arguments:
      "/Run /TN \\Microsoft\\Windows\\TextServicesFramework\\MsCtfMonitor",
    wait: true,
    show: "hidden",
  })

  const configPath = path.join(outputDir, "outto.toml")
  await oBuilder.write(configPath)
  logger.debug(`outto manifest written: ${configPath}`)

  const outputPath = path.join(outputDir, "install.exe")
  // Local validation can request an unsigned artifact without invoking any
  // signing/credential provider. CI retains its existing signed default.
  if (options.sign === false) {
    return await makeOuttoInstaller({
      configPath,
      sourceDir: payloadDir,
      outputPath,
      target: "windows",
    })
  }
  // A signing failure fails the build: the deploy refuses unsigned installers,
  // so an unsigned fallback would only hide the error behind a green step.
  return await makeOuttoInstaller({
    configPath,
    sourceDir: payloadDir,
    outputPath,
    target: "windows",
    ...windowsOuttoSigning(
      path.join(target.projectPath, "bin/divvun-actions.bat"),
    ),
  })
}

function addLayoutToOuttoManifest(
  oBuilder: OuttoBuilder,
  layout: WindowsLayout,
): string {
  // Runs before keyboard_install, which would otherwise register the layout
  // a second time beside an older Inno installer's entry.
  oBuilder.run({
    phase: "after_install",
    command: "#{app}/kbdi.exe",
    arguments: `keyboard_uninstall "${layout.legacyProductCode}"`,
    wait: true,
    show: "hidden",
  })

  const installArgs: string[] = [
    "keyboard_install",
    "-t",
    `"${layout.languageCode}"`,
  ]
  if (layout.languageName) {
    installArgs.push("-l", `"${layout.languageName}"`)
  }
  installArgs.push("-g", `"${layout.productCode}"`)
  installArgs.push("-d", layout.dllName)
  installArgs.push("-n", `"${layout.displayName}"`)

  oBuilder.run({
    phase: "after_install",
    command: "#{app}/kbdi.exe",
    arguments: installArgs.join(" "),
    wait: true,
    show: "hidden",
  })

  oBuilder.run({
    phase: "before_uninstall",
    command: "#{app}/kbdi.exe",
    arguments: `keyboard_uninstall "${layout.productCode}"`,
    wait: true,
    show: "hidden",
  })

  const enableArgs =
    `keyboard_enable -g "${layout.productCode}" -t "${layout.languageCode}"`
  oBuilder.shortcut({
    name: `Enable ${layout.displayName}`,
    target: "#{app}/kbdi.exe",
    location: "start_menu",
    arguments: enableArgs,
    description: `Enable ${layout.displayName} keyboard layout`,
  })
  return enableArgs
}

// ── macOS ─────────────────────────────────────────────────────────────────

/**
 * Wrap a kbdgen-produced keyboard layout `.bundle` (run kbdgen with
 * `--no-installer`) into an outto-built installer `.app`.
 *
 * The kbdgen bundle goes to `/Library/Keyboard Layouts/<bundle>` per the
 * legacy pkgbuild flow; outto preserves that placement.
 */
export async function buildKeyboardMacOSOutto(opts: {
  bundlePath: string
  generatedBundleDir: string
  outputDir: string
}): Promise<OuttoKeyboardResult> {
  const meta = await Kbdgen.loadTarget(opts.bundlePath, "macos")
  const project = await Kbdgen.loadProjectBundle(opts.bundlePath)

  const bundleDirAbs = path.resolve(opts.generatedBundleDir)
  const stageDir = path.dirname(bundleDirAbs)
  const bundleName = path.basename(bundleDirAbs)

  // Codesign the keyboard bundle before outto packages it.
  await codesignKeyboardBundle(bundleDirAbs)

  // macOS target YAML has packageId / bundleName / version (no appName/url —
  // those live on the project bundle).
  const oBuilder = new OuttoBuilder(stageDir, "macos")
    .id(`${meta.packageId}.keyboardlayout.${meta.bundleName}`)
    .name(`${project.name} (${meta.bundleName})`)
    .version(meta.version)
    .publisher(project.organisation)
    .url(project.url)
    .privileges("admin")
    .upgradePolicy("overwrite")
    .removeAppDirOnUninstall(true)
    .defaultDir(`#{library}/Keyboard Layouts/${bundleName}`)
    .file({
      source: bundleName,
      dest: "#{library}/Keyboard Layouts",
      bundle: true,
      overwrite: "always",
    })

  const configPath = path.join(stageDir, "outto.toml")
  await oBuilder.write(configPath)

  const outputPath = path.join(
    path.resolve(opts.outputDir),
    `${meta.packageId}.keyboardlayout.${meta.bundleName}.app`,
  )

  const result = await makeOuttoInstaller({
    configPath,
    sourceDir: stageDir,
    outputPath,
    target: "macos",
  })

  await macosSign(result.path)

  return { path: result.path, unsigned: false }
}

async function codesignKeyboardBundle(bundleDir: string): Promise<void> {
  const appCodeSignId =
    "Developer ID Application: The University of Tromso (2K5J2584NX)"

  await builder.exec("security", ["find-identity", "-v", "-p", "codesigning"])
  await builder.exec("security", [
    "unlock-keychain",
    "-p",
    "admin",
    "/Users/admin/Library/Keychains/login.keychain-db",
  ])

  const result = await builder.output("timeout", [
    "60s",
    "codesign",
    "-f",
    "-v",
    "-s",
    appCodeSignId,
    bundleDir,
  ])

  if (result.status.code !== 0) {
    throw new Error(
      `keyboard bundle signing failed: ${result.stderr}\nexit code: ${result.status.code}`,
    )
  }
}
