// Embedding the Divvun keyboard text service installer in keyboard installers
// (kbdgen spec tsf.installer.bundle). The text service is one shared
// installation; the keyboard installer runs the embedded installer before
// any `kbdi keyboard_install`, and after its own `kbdi keyboard_uninstall`
// runs the text service's uninstaller, which removes it only when no
// keyboard's language profile remains (tsf.register.uninstall).

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import {
  TIP_APP_DIR,
  TIP_DEV_TAG,
  TIP_NAME,
  TIP_SILENT_ARGS,
  TIP_TARGET,
  TIP_UNINSTALLER,
} from "~/actions/kbd-tsf/installer.ts"
import { assetPsPattern } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { makeTempDir } from "~/util/temp.ts"
import { verifyReleaseDownload } from "./release_asset.ts"

const REPO = "divvun/kbdgen"
export const TIP_DIRECTORY = "dependencies/divvun-tip"
export const TIP_INSTALLER = "divvun-tip-installer.exe"

/** Inno's `/SP-` skips the "This will install" prompt. */
export const TIP_INSTALL_ARGS = `${TIP_SILENT_ARGS} /SP-`

/** The release's one installer, checked against its BLAKE3SUMS. */
export function verifyTipDownload(directory: string): Promise<string> {
  return verifyReleaseDownload(
    directory,
    new RegExp(assetPsPattern(TIP_NAME, TIP_TARGET, "exe")),
    "text service",
  )
}

/**
 * Resolves the text service release once per keyboard build and stages its
 * installer as `<buildDir>/dependencies/divvun-tip/divvun-tip-installer.exe`,
 * so the keyboard installer works offline and every installer of one build
 * carries the same text service.
 */
export async function stageTipInstaller(buildDir: string): Promise<void> {
  if (!Deno.env.get("GH_TOKEN") && !Deno.env.get("GITHUB_TOKEN")) {
    Deno.env.set("GH_TOKEN", (await builder.secrets()).get("github/token"))
  }
  using downloaded = await makeTempDir({ prefix: "keyboard-tip-" })
  const gh = new GitHub(REPO)
  for (const pattern of [`${TIP_NAME}_${TIP_TARGET}_*.exe`, "BLAKE3SUMS"]) {
    await gh.downloadReleaseAssets(TIP_DEV_TAG, pattern, downloaded.path)
  }
  const installer = await verifyTipDownload(downloaded.path)
  const destination = path.join(buildDir, TIP_DIRECTORY)
  await Deno.mkdir(destination, { recursive: true })
  await Deno.copyFile(installer, path.join(destination, TIP_INSTALLER))
  logger.info(
    `Bundling ${REPO}@${TIP_DEV_TAG}: ${path.basename(installer)} (BLAKE3 checked)`,
  )
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
