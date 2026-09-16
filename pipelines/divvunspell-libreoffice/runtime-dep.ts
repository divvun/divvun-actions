// Fetch a libdivvun_runtime archive from divvun-runtime's rolling dev-latest
// release. Asset filenames embed a -dev.<timestamp>+build.<n> suffix, so we
// glob by target triple rather than pinning a version.

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { assetGhPattern } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"

const REPO = "divvun/divvun-runtime"
const TAG = "dev-latest"
const NAME = "libdivvun_runtime"

/**
 * Download the libdivvun_runtime archive for `target` into `outputDir` and
 * return the local archive path.
 */
export async function downloadDivvunRuntimeLib(
  target: string,
  outputDir: string,
): Promise<string> {
  // gh CLI on the agents won't run without GH_TOKEN; pull it from the secrets
  // store. Setting in the current process propagates to gh via inherited env.
  if (!Deno.env.get("GH_TOKEN")) {
    const secrets = await builder.secrets()
    Deno.env.set("GH_TOKEN", secrets.get("github/token"))
  }

  const gh = new GitHub(REPO)
  await gh.downloadReleaseAssets(
    TAG,
    assetGhPattern(NAME, target, "tar.xz"),
    outputDir,
  )
  // outputDir is created per download, so the archive just fetched is the only
  // .tar.xz in it. Matching the name a second time here would mean restating
  // the convention in a place that cannot be kept in step with asset_name.ts.
  for await (const entry of Deno.readDir(outputDir)) {
    if (entry.isFile && entry.name.endsWith(".tar.xz")) {
      return path.join(outputDir, entry.name)
    }
  }
  throw new Error(
    `No libdivvun_runtime archive found for ${target} in ${REPO}@${TAG}`,
  )
}
