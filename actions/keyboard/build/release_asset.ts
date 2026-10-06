import * as path from "@std/path"
import { blake3Hash } from "~/util/hash.ts"

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
      `Expected one ${label} installer, found ${candidates.length}`,
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
