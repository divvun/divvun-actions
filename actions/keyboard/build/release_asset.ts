import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import { blake3Hash } from "~/util/hash.ts"
import logger from "~/util/log.ts"

/**
 * The one file in `directory` matching `pattern`, not an `.UNSIGNED.exe`,
 * whose BLAKE3 matches its single entry in the directory's `BLAKE3SUMS`.
 * Missing, ambiguous and mismatched downloads throw.
 */
export async function verifyReleaseDownload(
  directory: string,
  pattern: RegExp,
  label: string,
): Promise<string> {
  const candidates: string[] = []
  for await (const file of Deno.readDir(directory)) {
    if (
      file.isFile && pattern.test(file.name) &&
      !file.name.endsWith(".UNSIGNED.exe")
    ) {
      candidates.push(file.name)
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one ${label} release asset, found ${candidates.length}`,
    )
  }
  const name = candidates[0]
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
      `${label} release BLAKE3 checksum mismatch or missing entry: ${name}`,
    )
  }
  return path.join(directory, name)
}

/**
 * Downloads the assets of `repo`'s `tag` release matching `ghPattern`, and
 * its `BLAKE3SUMS`, into `directory`, which must be empty, and returns the one
 * matching `pattern` that {@link verifyReleaseDownload} accepts.
 */
export async function downloadVerifiedReleaseAsset(opts: {
  repo: string
  tag: string
  ghPattern: string
  pattern: RegExp
  label: string
  directory: string
}): Promise<string> {
  if (!Deno.env.get("GH_TOKEN") && !Deno.env.get("GITHUB_TOKEN")) {
    Deno.env.set("GH_TOKEN", (await builder.secrets()).get("github/token"))
  }
  const gh = new GitHub(opts.repo)
  for (const pattern of [opts.ghPattern, "BLAKE3SUMS"]) {
    await gh.downloadReleaseAssets(opts.tag, pattern, opts.directory)
  }
  const asset = await verifyReleaseDownload(
    opts.directory,
    opts.pattern,
    opts.label,
  )
  logger.info(
    `Using ${opts.repo}@${opts.tag}: ${path.basename(asset)} (BLAKE3 checked)`,
  )
  return asset
}
