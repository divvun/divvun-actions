// Pahkat box packages, `.pkt.box` (pahkat spec artifact.box-*): a box archive
// whose archive attributes `pahkat.package` and `pahkat.version` name the
// release it belongs to, whose every file carries the `blake3` attribute
// `box create` writes by default, and which holds no links and allows
// neither escaped paths nor external links.

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import {
  BOX_HEADER_SIZE,
  boxTrailerOffset,
  withArchiveAttributes,
} from "~/util/box_attributes.ts"
import { makeTempDir } from "~/util/temp.ts"

export type PktBoxFile = {
  /** A regular file, stored at the archive's root under its own name. */
  path: string
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

  const args = ["create", "--quiet", "--force", output]
  const names = new Set<string>()
  for (const file of files) {
    const name = path.basename(file.path)
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
  await setArchiveAttributes(output, {
    "pahkat.package": pkg,
    "pahkat.version": version,
  })
  await builder.exec("box", ["validate", "--quiet", output])
}

/**
 * Rewrite the trailer of `archive` in place with `attributes` added. The
 * trailer starts where it did, so the header that points at it stands.
 */
async function setArchiveAttributes(
  archive: string,
  attributes: Record<string, string>,
): Promise<void> {
  using file = await Deno.open(archive, { read: true, write: true })
  const header = new Uint8Array(BOX_HEADER_SIZE)
  await readFully(file, header)
  const offset = boxTrailerOffset(header)

  const { size } = await file.stat()
  const trailer = new Uint8Array(size - offset)
  await file.seek(offset, Deno.SeekMode.Start)
  await readFully(file, trailer)

  const updated = withArchiveAttributes(trailer, attributes)
  await file.truncate(offset)
  await file.seek(offset, Deno.SeekMode.Start)
  let written = 0
  while (written < updated.length) {
    written += await file.write(updated.subarray(written))
  }
  await file.sync()
}

async function readFully(file: Deno.FsFile, buffer: Uint8Array) {
  let read = 0
  while (read < buffer.length) {
    const n = await file.read(buffer.subarray(read))
    if (n === null) throw new Error("The box archive ends early")
    read += n
  }
}
