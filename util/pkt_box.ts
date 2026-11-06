// Pahkat box packages, `.pkt.box` (pahkat spec artifact.box-*): a box archive
// whose archive attributes `pahkat.package` and `pahkat.version`, which
// `box create --attr` sets as strings, name the release it belongs to, whose
// every file carries the `blake3` attribute `box create` writes by default,
// and which holds no links and allows neither escaped paths nor external
// links.

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeTempDir } from "~/util/temp.ts"

export type PktBoxFile = {
  /** A regular file, stored at the archive's root. */
  path: string
  /** Its name in the archive; its own by default. */
  name?: string
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
    const name = file.name ?? path.basename(file.path)
    if (name !== path.basename(name)) {
      throw new Error(`${name} is not a name at the archive's root`)
    }
    if (names.has(name)) {
      throw new Error(`Two files named ${name} for ${path.basename(output)}`)
    }
    names.add(name)
    // A copy is a regular file even where the source is a link, so the
    // archive cannot hold one.
    await Deno.copyFile(file.path, path.join(stage.path, name))
    args.push(file.stored ? "--stored" : "--zstd", name)
  }
  if (names.size === 0) {
    throw new Error(`No files for ${path.basename(output)}`)
  }

  await builder.exec("box", args, { cwd: stage.path })
  await builder.exec("box", ["validate", "--quiet", output])
}
