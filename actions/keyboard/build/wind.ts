import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { assetFileName, assetPsPattern } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"
import { blake3Hash } from "~/util/hash.ts"
import logger from "~/util/log.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { makeTempDir } from "~/util/temp.ts"

const REPO = "divvun/divvun-wind"
const TAG = "dev-latest"
const TARGET = "x86_64-pc-windows-msvc"
export const WIND_DIRECTORY = "dependencies/divvun-wind"
export const WIND_FILES = [
  "divvun-wind-installer.exe",
  "install-wind.ps1",
] as const

/** Select exactly one supported installer and check it against the release's BLAKE3 list. */
export async function verifyWindDownload(directory: string): Promise<string> {
  const pattern = new RegExp(assetPsPattern("divvun-wind", TARGET, "exe"))
  const installers: string[] = []
  for await (const file of Deno.readDir(directory)) {
    if (
      file.isFile && pattern.test(file.name) &&
      !file.name.endsWith(".UNSIGNED.exe")
    ) {
      installers.push(file.name)
    }
  }
  if (installers.length !== 1) {
    throw new Error(
      `Expected one Wind x64 installer, found ${installers.length}`,
    )
  }
  const name = installers[0]
  const checksums = await Deno.readTextFile(path.join(directory, "BLAKE3SUMS"))
  const matching = checksums.split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64}) {2}(.+)$/.exec(line))
    .filter((entry) => entry?.[2] === name)
  if (
    matching.length !== 1 ||
    matching[0]![1].toLowerCase() !==
      await blake3Hash(path.join(directory, name))
  ) {
    throw new Error(
      `Wind release BLAKE3 checksum mismatch or missing entry: ${name}`,
    )
  }
  return path.join(directory, name)
}

/** Resolve dev-latest once per keyboard build; the resulting installer works offline. */
export async function stageWindInstaller(buildDir: string): Promise<void> {
  if (!Deno.env.get("GH_TOKEN") && !Deno.env.get("GITHUB_TOKEN")) {
    Deno.env.set("GH_TOKEN", (await builder.secrets()).get("github/token"))
  }
  using downloaded = await makeTempDir({ prefix: "keyboard-wind-" })
  const gh = new GitHub(REPO)
  for (
    const pattern of [
      assetFileName("divvun-wind", TARGET, "*", "exe"),
      "BLAKE3SUMS",
    ]
  ) {
    await gh.downloadReleaseAssets(TAG, pattern, downloaded.path)
  }
  const installer = await verifyWindDownload(downloaded.path)
  const destination = path.join(buildDir, WIND_DIRECTORY)
  await Deno.mkdir(destination, { recursive: true })
  await Deno.copyFile(installer, path.join(destination, WIND_FILES[0]))
  await Deno.copyFile(
    new URL("./install-wind.ps1", import.meta.url),
    path.join(destination, WIND_FILES[1]),
  )
  logger.info(
    `Bundling ${REPO}@${TAG}: ${path.basename(installer)} (BLAKE3 checked)`,
  )
}

export function addWindToOutto(manifest: OuttoBuilder): void {
  for (const name of WIND_FILES) {
    manifest.file({
      source: `${WIND_DIRECTORY}/${name}`,
      dest: `#{app}/${WIND_DIRECTORY}`,
      overwrite: "always",
    })
  }
  // The script guards architecture before trying to execute the x64 launcher.
  // Wind remains a shared product: keyboard uninstall only removes these setup files.
  manifest.run({
    phase: "after_install",
    command: "#{sys}/WindowsPowerShell/v1.0/powershell.exe",
    arguments:
      `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "#{app}/${WIND_DIRECTORY}/install-wind.ps1"`,
    wait: true,
    show: "hidden",
  })
}
