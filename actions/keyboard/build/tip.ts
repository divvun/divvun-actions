// Embedding the Divvun keyboard text service installer in the installers of
// kbdgen v4 keyboard builds (kbdgen spec tsf.installer.bundle). The text
// service is one shared installation; the keyboard installer runs the
// embedded installer before any `kbdi keyboard_install`, and after its own
// `kbdi keyboard_uninstall` runs the text service's uninstaller, which
// removes it only when no keyboard's language profile remains
// (tsf.register.uninstall).

import * as path from "@std/path"
import {
  TIP_APP_DIR,
  TIP_NAME,
  TIP_SILENT_ARGS,
  TIP_TARGET,
  TIP_UNINSTALLER,
} from "~/actions/kbd-tsf/installer.ts"
import { assetPsPattern } from "~/util/asset_name.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { KBDGEN_REPO } from "~/actions/kbdgen/v4.ts"
import { downloadVerifiedReleaseAsset } from "./release_asset.ts"

export const TIP_DIRECTORY = "dependencies/divvun-tip"
export const TIP_INSTALLER = "divvun-tip-installer.exe"

/** Inno's `/SP-` skips the "This will install" prompt. */
export const TIP_INSTALL_ARGS = `${TIP_SILENT_ARGS} /SP-`

/** `tag`'s text service installer, checked against its BLAKE3SUMS. */
export function downloadTipInstaller(
  tag: string,
  directory: string,
): Promise<string> {
  return downloadVerifiedReleaseAsset({
    repo: KBDGEN_REPO,
    tag,
    ghPattern: `${TIP_NAME}_${TIP_TARGET}_*.exe`,
    pattern: new RegExp(assetPsPattern(TIP_NAME, TIP_TARGET, "exe")),
    label: "text service",
    directory,
  })
}

/**
 * Stages `installer` as
 * `<buildDir>/dependencies/divvun-tip/divvun-tip-installer.exe`, so the
 * keyboard installer works offline and every installer of one build carries
 * the same text service.
 */
export async function stageTipInstaller(
  buildDir: string,
  installer: string,
): Promise<void> {
  const destination = path.join(buildDir, TIP_DIRECTORY)
  await Deno.mkdir(destination, { recursive: true })
  await Deno.copyFile(installer, path.join(destination, TIP_INSTALLER))
}

/**
 * Adds the text service installer to an outto keyboard manifest, to run
 * after install. Call it before adding the layouts' kbdi runs, which need
 * the text service registered; outto runs a phase's entries in order. A
 * failing text service setup leaves the keyboard on its layout
 * (tsf.register.enable).
 */
export function addTipInstallToOutto(manifest: OuttoBuilder): void {
  manifest.file({
    source: `${TIP_DIRECTORY}/${TIP_INSTALLER}`,
    dest: `#{app}/${TIP_DIRECTORY}`,
    overwrite: "always",
  })
  manifest.run({
    phase: "after_install",
    command: `#{app}/${TIP_DIRECTORY}/${TIP_INSTALLER}`,
    arguments: TIP_INSTALL_ARGS,
    wait: true,
    show: "hidden",
  })
}

/**
 * Adds the text service's uninstaller to an outto keyboard manifest. Call it
 * after adding the layouts' `kbdi keyboard_uninstall` runs: Windows ignores
 * the removal of a TIP string once the text service is unregistered.
 */
export function addTipUninstallToOutto(manifest: OuttoBuilder): void {
  manifest.run({
    phase: "before_uninstall",
    command: `#{pf}/${TIP_APP_DIR.replaceAll("\\", "/")}/${TIP_UNINSTALLER}`,
    arguments: TIP_SILENT_ARGS,
    wait: true,
    show: "hidden",
  })
}
