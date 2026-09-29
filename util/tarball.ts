import * as path from "@std/path"
import logger from "~/util/log.ts"

/**
 * Tarballs via bsdtar, which on the Linux agents supports multithreaded zstd
 * and detects compression when reading. Check that an agent's bsdtar has zstd
 * before using this elsewhere. On a lang build's dependency repos zstd -9 was
 * 4x faster than gzip -1 and 40% smaller.
 */

export const DEFAULT_ZSTD_LEVEL = 9

async function bsdtar(args: string[], cwd?: string): Promise<string> {
  const out = await new Deno.Command("bsdtar", {
    args,
    cwd,
    stdout: "piped",
    stderr: "inherit",
  }).output()
  if (out.code !== 0) {
    throw new Error(
      `bsdtar ${args.join(" ")} failed with exit code ${out.code}`,
    )
  }
  return new TextDecoder().decode(out.stdout)
}

/**
 * Pack `paths` (relative to `cwd`) into `archive`. `exclude` patterns match
 * archived paths as stored (`./build/x.drb` when `paths` is `["."]`).
 *
 * File names are stored as raw bytes (hdrcharset=BINARY): by default bsdtar
 * converts them from the locale's charset, which fails for non-ASCII names in
 * the agents' C locale.
 */
export async function createTarZst(
  archive: string,
  paths: string[],
  opts: { cwd: string; exclude?: string[]; level?: number },
): Promise<void> {
  const level = opts.level ?? DEFAULT_ZSTD_LEVEL
  const start = performance.now()
  await bsdtar([
    "--zstd",
    "--options",
    `zstd:compression-level=${level},zstd:threads=0,hdrcharset=BINARY`,
    ...(opts.exclude ?? []).flatMap((pattern) => ["--exclude", pattern]),
    "-cf",
    path.resolve(opts.cwd, archive),
    ...paths,
  ], opts.cwd)
  const { size } = await Deno.stat(path.resolve(opts.cwd, archive))
  logger.info(
    `${path.basename(archive)} is ${(size / 1024 / 1024).toFixed(1)} MiB ` +
      `(zstd -${level}, ${((performance.now() - start) / 1000).toFixed(1)} s)`,
  )
}

/** The paths in a tarball, as it stores them. */
export async function listTarball(archive: string): Promise<string[]> {
  return (await bsdtar(["-tf", path.resolve(archive)]))
    .split("\n")
    .filter((entry) => entry !== "")
}

/**
 * Unpack into `cwd`, restoring mtimes and permissions. `paths` limits it to
 * those members.
 */
export async function extractTarball(
  archive: string,
  opts: { cwd: string; paths?: string[] },
): Promise<void> {
  await bsdtar(["-xpf", path.resolve(archive), ...(opts.paths ?? [])], opts.cwd)
}
