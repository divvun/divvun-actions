// Where a build leaves the artifacts of a Pahkat-next release for the step
// that publishes them: the Buildkite artifact `pahkat/<package>/<file>.pahkat`,
// `<file>` the artifact's own name, such as
// `pahkat/speller-sme/speller-sme_4.5.2_noarch-mobile.pkt.box.pahkat`.
//
// Buildkite's download patterns match across directories, so the deploy
// steps of the old pahkat.uit.no, which download `*.exe`, `*.pkg` and
// `*.pkt.tar.zst`, would take any artifact ending in one of those. The
// suffix keeps every Pahkat-next artifact out of them. The publishing step
// downloads `pahkat/<package>/*` and drops the suffix.

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeTempDir } from "~/util/temp.ts"

export const PAHKAT_ARTIFACT_SUFFIX = ".pahkat"

export function pahkatArtifactPath(pkg: string, fileName: string): string {
  return `pahkat/${pkg}/${fileName}${PAHKAT_ARTIFACT_SUFFIX}`
}

/** The artifact's own name: `artifactPath`'s file name without the suffix. */
export function pahkatArtifactName(artifactPath: string): string {
  const name = path.basename(artifactPath)
  if (!name.endsWith(PAHKAT_ARTIFACT_SUFFIX)) {
    throw new Error(`${artifactPath} is not a Pahkat artifact`)
  }
  return name.slice(0, -PAHKAT_ARTIFACT_SUFFIX.length)
}

/**
 * Upload `file` as an artifact of package `pkg`, named `name`, its own name
 * by default. The file is moved, so it must be in the current directory's
 * file system and is gone afterwards, unless `keep` copies it instead.
 */
export async function uploadPahkatArtifact(
  pkg: string,
  file: string,
  { name = path.basename(file), keep = false }: {
    name?: string
    keep?: boolean
  } = {},
): Promise<string> {
  const artifact = pahkatArtifactPath(pkg, name)
  using root = await makeTempDir({ dir: Deno.cwd(), prefix: ".pahkat-" })
  const staged = path.join(root.path, artifact)
  await Deno.mkdir(path.dirname(staged), { recursive: true })
  if (keep) {
    await Deno.copyFile(file, staged)
  } else {
    await Deno.rename(file, staged)
  }
  await builder.uploadArtifacts(artifact, { cwd: root.path })
  return artifact
}
