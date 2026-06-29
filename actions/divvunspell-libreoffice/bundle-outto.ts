// Wrap a divvunspell-libreoffice .oxt in an outto installer.
//
// Output:
//   - Windows: signed .exe (via divvun-actions.bat sign)
//   - macOS:   notarized .app (signed via rcodesign + notarised)
//
// The installer ships the .oxt, the `oxtreg` registration tool, and a small
// install-extension script alongside each other. After install (and before
// uninstall) the script runs oxtreg to write the extension cache directly —
// no unopkg, no LibreOffice tooling at install time:
//   - macOS:   the console user's per-user profile (running as that user).
//   - Windows: the shared (all-users) cache of every LibreOffice install.

import * as path from "@std/path"
import { makeOuttoInstaller } from "~/actions/outto/lib.ts"
import macosSign from "~/services/macos-codesign.ts"
import * as target from "~/target.ts"
import { makeTempDir } from "~/util/temp.ts"
import { OuttoBuilder, type OuttoPlatform } from "~/util/outto.ts"
import logger from "~/util/log.ts"

const SCRIPTS_DIR = path.join(
  target.projectPath,
  "actions/divvunspell-libreoffice",
)
const MACOS_SCRIPT = "install-extension.sh"
const WINDOWS_SCRIPT = "install-extension.ps1"

export const EXTENSION_ID = "no.divvun.DivvunSpell"
export const EXTENSION_NAME = "Divvun for LibreOffice"
export const PUBLISHER = "Universitetet i Tromsø - Norges arktiske universitet"
export const PROJECT_URL = "https://divvun.no/"

export type BundleOuttoProps = {
  platform: OuttoPlatform
  /** Path to the .oxt that will be wrapped. */
  oxtPath: string
  /** Semver-compatible version string (e.g. 0.5.0 or 0.5.0-dev.20260527T...). */
  version: string
  /** Path to the oxtreg binary to ship (oxtreg.exe on windows, oxtreg on macos). */
  oxtregPath: string
  /** Final installer output path. Should end in .exe (windows) or .app (macos). */
  outputPath: string
}

export type BundleOuttoResult = {
  payloadPath: string
  unsigned: boolean
}

export async function bundleLibreOfficeOutto(
  props: BundleOuttoProps,
): Promise<BundleOuttoResult> {
  switch (props.platform) {
    case "windows":
      return await bundleWindows(props)
    case "macos":
      return await bundleMacOS(props)
  }
}

// ── Windows ────────────────────────────────────────────────────────────────

async function bundleWindows(
  props: BundleOuttoProps,
): Promise<BundleOuttoResult> {
  using stage = await makeTempDir({ prefix: "outto-lo-win-" })

  const oxtName = "divvunspell.oxt"
  const oxtregName = "oxtreg.exe"
  await Deno.copyFile(props.oxtPath, path.join(stage.path, oxtName))
  await Deno.copyFile(props.oxtregPath, path.join(stage.path, oxtregName))
  await Deno.copyFile(
    path.join(SCRIPTS_DIR, WINDOWS_SCRIPT),
    path.join(stage.path, WINDOWS_SCRIPT),
  )

  const oBuilder = new OuttoBuilder(stage.path, "windows")
    .id(EXTENSION_ID)
    .name(EXTENSION_NAME)
    .version(props.version)
    .publisher(PUBLISHER)
    .url(PROJECT_URL)
    .privileges("admin")
    .architecture("any")
    .defaultDir(`#{pf}/Divvun/LibreOffice`)
    .upgradePolicy("overwrite")
    .removeAppDirOnUninstall(true)
    .file({ source: oxtName, dest: "#{app}", overwrite: "always" })
    .file({ source: oxtregName, dest: "#{app}", overwrite: "always" })
    .file({ source: WINDOWS_SCRIPT, dest: "#{app}", overwrite: "always" })
    .run({
      phase: "after_install",
      command: "powershell.exe",
      arguments:
        `-NoProfile -ExecutionPolicy Bypass -File "#{app}/${WINDOWS_SCRIPT}" -Action add -Target "#{app}/${oxtName}"`,
      wait: true,
      show: "hidden",
    })
    .run({
      phase: "before_uninstall",
      command: "powershell.exe",
      arguments:
        `-NoProfile -ExecutionPolicy Bypass -File "#{app}/${WINDOWS_SCRIPT}" -Action remove -Target ${EXTENSION_ID}`,
      wait: true,
      show: "hidden",
    })

  const configPath = path.join(stage.path, "outto.toml")
  await oBuilder.write(configPath)

  const signCommand = `${target.projectPath}\\bin\\divvun-actions.bat sign`

  try {
    return mapResult(
      await makeOuttoInstaller({
        configPath,
        sourceDir: stage.path,
        outputPath: props.outputPath,
        target: "windows",
        signCommand,
      }),
    )
  } catch (err) {
    logger.warning(
      `outto build with signing failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    logger.warning("Retrying without signing...")
    const unsignedOut = props.outputPath.replace(/\.exe$/, ".UNSIGNED.exe")
    return mapResult(
      await makeOuttoInstaller({
        configPath,
        sourceDir: stage.path,
        outputPath: unsignedOut,
        target: "windows",
      }),
    )
  }
}

// ── macOS ──────────────────────────────────────────────────────────────────

async function bundleMacOS(
  props: BundleOuttoProps,
): Promise<BundleOuttoResult> {
  using stage = await makeTempDir({ prefix: "outto-lo-mac-" })

  const oxtName = "divvunspell.oxt"
  const oxtregName = "oxtreg"
  await Deno.copyFile(props.oxtPath, path.join(stage.path, oxtName))
  const stagedOxtreg = path.join(stage.path, oxtregName)
  await Deno.copyFile(props.oxtregPath, stagedOxtreg)
  await Deno.chmod(stagedOxtreg, 0o755)
  const stagedScript = path.join(stage.path, MACOS_SCRIPT)
  await Deno.copyFile(path.join(SCRIPTS_DIR, MACOS_SCRIPT), stagedScript)
  await Deno.chmod(stagedScript, 0o755)

  const oBuilder = new OuttoBuilder(stage.path, "macos")
    .id(EXTENSION_ID)
    .name(EXTENSION_NAME)
    .version(props.version)
    .publisher(PUBLISHER)
    .url(PROJECT_URL)
    .defaultDir(`#{library}/Application Support/Divvun/LibreOffice`)
    .privileges("admin")
    .minMacosVersion("11.0")
    .upgradePolicy("overwrite")
    .removeAppDirOnUninstall(true)
    .file({ source: oxtName, dest: "#{app}", overwrite: "always" })
    .file({ source: oxtregName, dest: "#{app}", overwrite: "always" })
    .file({ source: MACOS_SCRIPT, dest: "#{app}", overwrite: "always" })
    .run({
      phase: "after_install",
      command: "/bin/bash",
      arguments: `"#{app}/${MACOS_SCRIPT}" add "#{app}/${oxtName}"`,
      wait: true,
    })
    .run({
      phase: "before_uninstall",
      command: "/bin/bash",
      arguments: `"#{app}/${MACOS_SCRIPT}" remove ${EXTENSION_ID}`,
      wait: true,
    })

  const configPath = path.join(stage.path, "outto.toml")
  await oBuilder.write(configPath)

  const result = await makeOuttoInstaller({
    configPath,
    sourceDir: stage.path,
    outputPath: props.outputPath,
    target: "macos",
  })

  // Notarise + staple the resulting .app.
  await macosSign(result.path)

  return { payloadPath: result.path, unsigned: false }
}

function mapResult(
  r: { path: string; unsigned: boolean },
): BundleOuttoResult {
  return { payloadPath: r.path, unsigned: r.unsigned }
}
