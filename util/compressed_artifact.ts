import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { globFiles } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { createTarZst, extractTarball } from "~/util/tarball.ts"
import { makeTempDir } from "~/util/temp.ts"

/**
 * Large build outputs (a grammar checker's .drb and .zcheck, ~600 MiB each)
 * shrink ~10x under zstd -9 in about half a second, where downloading them
 * plain takes ~20 s per file. Each is uploaded as a one-file tarball at its
 * own path plus this suffix, so it unpacks back into place with its build
 * mtime (which keeps make from rebuilding it).
 */
export const COMPRESSED_SUFFIX = ".tar.zst"

/**
 * Upload each file matching `glob` (relative to the current directory) as
 * `<path>.tar.zst`. The archives are packed in a temporary directory, so none
 * are left in the build tree.
 */
export async function uploadCompressedArtifacts(glob: string): Promise<void> {
  const files = await globFiles(glob)
  if (files.length === 0) {
    logger.warning(`No files match ${glob}; nothing to upload`)
    return
  }
  const workDir = (await makeTempDir({ prefix: "compressed-artifact-" })).path
  try {
    for (const file of files) {
      const relative = path.relative(Deno.cwd(), file)
      const archive = path.join(workDir, relative + COMPRESSED_SUFFIX)
      await Deno.mkdir(path.dirname(archive), { recursive: true })
      await createTarZst(archive, [relative], { cwd: Deno.cwd() })
      await builder.uploadArtifacts(relative + COMPRESSED_SUFFIX, {
        cwd: workDir,
      })
    }
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}

/**
 * Download the files matching `glob` into place under the current directory:
 * their `.tar.zst` artifacts, unpacked, or else the plain files, which a build
 * uploaded before these were compressed still has.
 */
export async function downloadCompressedArtifacts(
  glob: string,
): Promise<void> {
  const workDir = (await makeTempDir({ prefix: "compressed-artifact-" })).path
  try {
    try {
      await builder.downloadArtifacts(glob + COMPRESSED_SUFFIX, workDir)
    } catch {
      logger.info(`No ${glob}${COMPRESSED_SUFFIX}; downloading ${glob} as is`)
      await builder.downloadArtifacts(glob, ".")
      return
    }
    const archives = await globFiles(glob + COMPRESSED_SUFFIX, {
      root: workDir,
    })
    for (const archive of archives) {
      logger.info(`Extracting ${path.relative(workDir, archive)}`)
      await extractTarball(archive, { cwd: Deno.cwd() })
    }
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}
