// Pahkat box packages, `.pkt.box` (pahkat spec artifact.box-*): a box archive
// whose archive attributes `pahkat.package` and `pahkat.version`, which
// `box create --attr` sets as strings, name the release it belongs to, whose
// every file carries the `blake3` attribute `box create` writes by default,
// and which holds no links and allows neither escaped paths nor external
// links. Its files sit where they go under a Unix prefix (artifact.box-layout):
// the client links each into its prefix at the same path.

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeTempDir } from "~/util/temp.ts"

/** The top-level directories of a prefix a package may put files in. */
const PREFIX_DIRS = ["bin", "lib", "share"]

export type PktBoxFile = {
  /** A regular file. */
  path: string
  /**
   * Where it goes in the archive, and so in the prefix: under `bin/`,
   * `lib/` or `share/`, such as `share/divvun/proofing/se.drb`.
   */
  at: string
  /**
   * Store it uncompressed: box maps only stored files, so a file a keyboard
   * reads in place from the archive must be stored. Others are zstd.
   */
  stored?: boolean
}

/**
 * Pack `files` into `archive` as `version` of `pkg`, the package's id without
 * its repository, such as `speller-sme` for `main/speller-sme`.
 */
export async function createPktBox(
  archive: string,
  { pkg, version, files }: {
    pkg: string
    version: string
    files: PktBoxFile[]
  },
): Promise<void> {
  const output = path.resolve(archive)
  using stage = await makeTempDir({ prefix: "pkt-box-" })

  // The options go before the archive: everything after it is an input.
  const args = [
    "create",
    "--quiet",
    "--force",
    "--attr",
    `pahkat.package=${pkg}`,
    "--attr",
    `pahkat.version=${version}`,
    output,
  ]
  const names = new Set<string>()
  for (const file of files) {
    const parts = file.at.split("/")
    if (
      parts.length < 2 || !PREFIX_DIRS.includes(parts[0]) ||
      parts.some((part) => part === "" || part === "." || part === "..") ||
      file.at.includes("\\")
    ) {
      throw new Error(
        `${file.at} is not a path under ${PREFIX_DIRS.join("/, ")}/`,
      )
    }
    if (names.has(file.at)) {
      throw new Error(`Two files at ${file.at} for ${path.basename(output)}`)
    }
    names.add(file.at)
    // A copy is a regular file even where the source is a link, so the
    // archive cannot hold one.
    const staged = path.join(stage.path, ...parts)
    await Deno.mkdir(path.dirname(staged), { recursive: true })
    await Deno.copyFile(file.path, staged)
    args.push(file.stored ? "--stored" : "--zstd", file.at)
  }
  if (names.size === 0) {
    throw new Error(`No files for ${path.basename(output)}`)
  }

  await builder.exec("box", args, { cwd: stage.path })
  await builder.exec("box", ["validate", "--quiet", output])
}
