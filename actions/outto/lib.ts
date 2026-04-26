// Invocation wrapper for the `outto build` CLI.
//
// outto stages a source directory, reads a TOML manifest, and emits a single
// installer artifact:
//   - Windows: a self-extracting `.exe`
//   - macOS:   an `.app` bundle
//
// This module is the opt-in equivalent of actions/inno-setup/lib.ts:makeInstaller.
// It assumes `outto` is on PATH (provisioned by the builder image).

import * as path from "@std/path"
import logger from "~/util/log.ts"

export type OuttoTarget = "windows" | "macos"

export type MakeOuttoInstallerOpts = {
  /** Path to the outto.toml manifest (already written by OuttoBuilder.write). */
  configPath: string
  /** Staging dir whose contents will be packaged. Becomes outto's --source. */
  sourceDir: string
  /** Output artifact path (.exe on Windows, .app on macOS). */
  outputPath: string
  /** Target platform. Used to validate the output extension matches. */
  target: OuttoTarget
  /**
   * Sign command to pass to outto via -S. outto invokes this with the
   * binary/app path appended. Caller is responsible for env (e.g. signtool
   * config on Windows, rcodesign credentials on macOS).
   */
  signCommand?: string
  /** Apply zstd compression to the staged payload. */
  compress?: boolean
  /** Compression level 0..22 (only meaningful when compress=true). */
  compressionLevel?: number
}

export type OuttoInstallerResult = {
  path: string
  unsigned: boolean
}

export async function makeOuttoInstaller(
  opts: MakeOuttoInstallerOpts,
): Promise<OuttoInstallerResult> {
  const expectedExt = opts.target === "windows" ? ".exe" : ".app"
  if (!opts.outputPath.endsWith(expectedExt)) {
    throw new Error(
      `outputPath must end in ${expectedExt} for target=${opts.target}, got ${opts.outputPath}`,
    )
  }

  const args = [
    "build",
    "--config",
    opts.configPath,
    "--source",
    opts.sourceDir,
    "--output",
    opts.outputPath,
  ]
  if (opts.compress) args.push("--compress")
  if (opts.compressionLevel != null) {
    args.push("--compression-level", String(opts.compressionLevel))
  }
  if (opts.signCommand) args.push("--sign", opts.signCommand)

  logger.debug(`outto ${args.join(" ")}`)

  const proc = new Deno.Command("outto", { args }).spawn()
  const status = await proc.status
  if (!status.success) {
    if (opts.signCommand) {
      logger.warning(
        `outto build with signing failed (exit ${status.code}). Caller can retry without --sign.`,
      )
    }
    throw new Error(`outto build failed (exit ${status.code})`)
  }

  // outto resolves the output path itself; verify it landed where we asked.
  try {
    await Deno.stat(opts.outputPath)
  } catch {
    throw new Error(`outto reported success but ${opts.outputPath} is missing`)
  }

  return {
    path: path.resolve(opts.outputPath),
    unsigned: opts.signCommand == null,
  }
}
