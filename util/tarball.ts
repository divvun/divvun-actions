import * as path from "@std/path"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"

/**
 * Tarballs made and read with bsdtar (libarchive), which the Linux agents
 * already use for zstd (`Tar.createFlatPkt`): it compresses with zstd on as
 * many threads as there are cores, and detects the compression of an archive
 * it reads, so `listTarball` and `extractTarball` read .tar.zst and .tar.gz
 * alike. Check that an agent's bsdtar has zstd before using this elsewhere.
 *
 * zstd rather than gzip: on a lang build's dependency repos (762 MiB of
 * tar), gzip -1 took 3.0 s to make 180 MiB, zstd -9 on 14 threads 0.7 s to
 * make 104 MiB, and zstd decompresses faster too.
 */

/** zstd level `createTarZst` uses by default: most of the size, little time. */
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
 * Pack `paths` (relative to `cwd`) into the zstd-compressed tarball
 * `archive`, keeping modification times and permissions. `exclude` takes
 * bsdtar patterns, matched against each archived path (`./build/x.drb` when
 * `paths` is `["."]`) at any directory boundary.
 *
 * File names are stored as the bytes they are on disk (hdrcharset=BINARY)
 * and so come back exactly as they were. By default bsdtar converts them to
 * UTF-8 from the locale's charset, which on the agents (C locale) fails for
 * any non-ASCII name (lang-smj's insert-æae-area-flags.regex) with a warning
 * per file, and which in a UTF-8 locale on macOS can change their bytes.
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
 * Unpack a tarball into `cwd`, restoring modification times and
 * permissions, so make sees built files exactly as they were built. `paths`
 * limits it to those members.
 */
export async function extractTarball(
  archive: string,
  opts: { cwd: string; paths?: string[] },
): Promise<void> {
  await bsdtar(["-xpf", path.resolve(archive), ...(opts.paths ?? [])], opts.cwd)
}

/** First line of `<command> --version`, or why there is none. */
async function versionOf(command: string): Promise<string> {
  try {
    const out = await new Deno.Command(command, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    }).output()
    const text = new TextDecoder().decode(out.success ? out.stdout : out.stderr)
    return text.trim().split("\n")[0] || `exit code ${out.code}`
  } catch (e) {
    return e instanceof Deno.errors.NotFound ? "not found" : String(e)
  }
}

/**
 * Log whether this agent can make and read the tarballs this module makes,
 * by making and reading one with the same commands. For finding out which
 * agents (macOS, Windows) are ready before any artifact they download is
 * compressed, so it never throws: the answer is only logged, as one line
 * starting "zstd tarballs: ready" or "zstd tarballs: NOT ready".
 */
export async function logZstdSupport(): Promise<void> {
  const facts = [
    `os: ${Deno.build.os}/${Deno.build.arch}`,
    `bsdtar: ${await versionOf("bsdtar")}`,
    `zstd: ${await versionOf("zstd")}`,
  ]
  let ready = false
  let dir: string | undefined
  try {
    dir = (await makeTempDir({ prefix: "zstd-probe-" })).path
    const content = "zstd probe\n"
    await Deno.mkdir(path.join(dir, "in"))
    await Deno.mkdir(path.join(dir, "out"))
    await Deno.writeTextFile(path.join(dir, "in", "probe.txt"), content)
    await createTarZst(path.join(dir, "probe.tar.zst"), ["probe.txt"], {
      cwd: path.join(dir, "in"),
    })
    await extractTarball(path.join(dir, "probe.tar.zst"), {
      cwd: path.join(dir, "out"),
    })
    const back = await Deno.readTextFile(path.join(dir, "out", "probe.txt"))
    ready = back === content
    facts.push(ready ? "round trip: ok" : "round trip: content differs")
  } catch (e) {
    facts.push(`round trip: ${e instanceof Error ? e.message : e}`)
  } finally {
    if (dir) {
      await Deno.remove(dir, { recursive: true }).catch(() => {})
    }
  }
  logger.info(
    `zstd tarballs: ${ready ? "ready" : "NOT ready"} (${facts.join("; ")})`,
  )
}
