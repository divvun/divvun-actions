// Fetch a libdivvun_runtime archive from divvun-runtime's rolling dev-latest
// release. Asset filenames there embed a -dev.<timestamp>+build.<n> suffix,
// so we glob by target triple rather than pinning a version.

import * as path from "@std/path"
import { GitHub } from "~/util/github.ts"

const REPO = "divvun/divvun-runtime"
const TAG = "dev-latest"

/**
 * Download the libdivvun_runtime archive for `target` into `outputDir` and
 * return the local archive path.
 */
export async function downloadDivvunRuntimeLib(
  target: string,
  outputDir: string,
): Promise<string> {
  const gh = new GitHub(REPO)
  await gh.downloadReleaseAssets(
    TAG,
    `libdivvun_runtime-${target}-*.tar.xz`,
    outputDir,
  )
  for await (const entry of Deno.readDir(outputDir)) {
    if (
      entry.isFile &&
      entry.name.startsWith(`libdivvun_runtime-${target}-`) &&
      entry.name.endsWith(".tar.xz")
    ) {
      return path.join(outputDir, entry.name)
    }
  }
  throw new Error(
    `No libdivvun_runtime archive found for ${target} in ${REPO}@${TAG}`,
  )
}
