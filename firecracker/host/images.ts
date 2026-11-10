import * as path from "@std/path"
import logger from "~/util/log.ts"
import { pipe, run } from "./cmd.ts"
import type { Config } from "./config.ts"
import { envFile, GUEST_INIT, imageEnv } from "./vm.ts"

const PLATFORM = "linux/amd64"
const VERSIONS_KEPT = 2

/** One converted image or kernel: a directory named by its digest. */
export type Version = {
  dir: string
  /** The pinned reference it was built from, `<repo>@sha256:<hex>`. */
  ref: string
}

export function kernelDir(config: Config): string {
  return path.join(config.stateDir, "kernel")
}

export function imageDir(config: Config, ref: string): string {
  return path.join(
    config.stateDir,
    "images",
    ref.replace(/@sha256:.*$/, "").replace(/[^A-Za-z0-9.-]/g, "_"),
  )
}

/** Files every bootable image must have, checked on a loop mount. */
const REQUIRED_IN_ROOTFS = [
  GUEST_INIT,
  "/usr/local/bin/buildkite-agent",
  "/bin/bash",
  "/dev",
  "/mnt",
  "/proc",
  "/sys",
]

export async function currentVersion(dir: string): Promise<Version | null> {
  let target: string
  try {
    target = await Deno.readLink(path.join(dir, "current"))
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null
    throw e
  }
  const versionDir = path.join(dir, target)
  const ref = (await Deno.readTextFile(path.join(versionDir, "ref"))).trim()
  return { dir: versionDir, ref }
}

function pinned(ref: string, digest: string): string {
  return `${ref.replace(/@sha256:.*$/, "")}@${digest}`
}

async function resolveDigest(config: Config, ref: string): Promise<string> {
  const out = await run(config.craneBin, [
    "digest",
    "--platform",
    PLATFORM,
    ref,
  ])
  const digest = out.stdout.trim()
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`crane digest ${ref} printed "${digest}"`)
  }
  return digest
}

async function setCurrent(dir: string, name: string): Promise<void> {
  const next = path.join(dir, "current.next")
  await Deno.remove(next).catch(() => {})
  await Deno.symlink(name, next)
  await Deno.rename(next, path.join(dir, "current"))
}

/**
 * Keep the current version and the one before it. A running VM holds hard
 * links to its files inside its jail, so removing a version it booted from
 * does not pull the disk out from under it.
 */
async function prune(dir: string): Promise<void> {
  const current = await Deno.readLink(path.join(dir, "current"))
  const versions: { name: string; mtime: number }[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isDirectory) continue
    const full = path.join(dir, entry.name)
    if (entry.name.endsWith(".partial")) {
      await Deno.remove(full, { recursive: true })
      continue
    }
    const stat = await Deno.stat(full)
    versions.push({ name: entry.name, mtime: stat.mtime?.getTime() ?? 0 })
  }
  versions.sort((a, b) => b.mtime - a.mtime)
  const keep = new Set([current])
  for (const v of versions) {
    if (keep.size >= VERSIONS_KEPT) break
    keep.add(v.name)
  }
  for (const v of versions) {
    if (!keep.has(v.name)) {
      logger.info(`Removing ${path.join(dir, v.name)}`)
      await Deno.remove(path.join(dir, v.name), { recursive: true })
    }
  }
}

/**
 * Point `dir/current` at the conversion of the digest `ref` resolves to,
 * converting it with `build` first if it is new. Returns whether `current`
 * moved.
 */
async function update(
  config: Config,
  dir: string,
  ref: string,
  build: (pinnedRef: string, into: string) => Promise<void>,
): Promise<boolean> {
  const digest = await resolveDigest(config, ref)
  const name = digest.slice("sha256:".length)
  const versionDir = path.join(dir, name)
  const current = await currentVersion(dir)
  if (current?.dir === versionDir) return false

  await Deno.mkdir(dir, { recursive: true })
  let exists = true
  try {
    await Deno.stat(path.join(versionDir, "ref"))
  } catch {
    exists = false
  }
  if (!exists) {
    const pinnedRef = pinned(ref, digest)
    const partial = `${versionDir}.partial`
    await Deno.remove(partial, { recursive: true }).catch(() => {})
    await Deno.mkdir(partial)
    logger.info(`Converting ${pinnedRef}`)
    const started = Date.now()
    await build(pinnedRef, partial)
    await Deno.writeTextFile(path.join(partial, "ref"), pinnedRef + "\n")
    await Deno.rename(partial, versionDir)
    logger.info(
      `Converted ${pinnedRef} in ${Math.round((Date.now() - started) / 1000)}s`,
    )
  }
  await setCurrent(dir, name)
  logger.info(`${dir}: current is now ${digest}`)
  await prune(dir)
  return true
}

async function buildKernel(config: Config, ref: string, into: string) {
  await pipe(
    {
      cmd: config.craneBin,
      args: ["export", "--platform", PLATFORM, ref, "-"],
    },
    { cmd: "tar", args: ["-x", "-C", into] },
  )
  const stat = await Deno.stat(path.join(into, "vmlinux"))
  if (!stat.isFile || stat.size === 0) {
    throw new Error(`${ref} has no /vmlinux`)
  }
}

async function verifyRootfs(file: string): Promise<void> {
  const mnt = await Deno.makeTempDir({ prefix: "divvun-fc-verify-" })
  try {
    await run("mount", ["-t", "erofs", "-o", "ro,loop", file, mnt])
    try {
      const missing: string[] = []
      for (const p of REQUIRED_IN_ROOTFS) {
        try {
          await Deno.stat(path.join(mnt, p))
        } catch {
          missing.push(p)
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `the image cannot boot as a microVM, it lacks ${missing.join(", ")}`,
        )
      }
    } finally {
      await run("umount", [mnt])
    }
  } finally {
    await Deno.remove(mnt)
  }
}

async function buildImage(config: Config, ref: string, into: string) {
  const imageConfig = JSON.parse(
    (await run(config.craneBin, ["config", "--platform", PLATFORM, ref]))
      .stdout,
  )
  const env = imageEnv(imageConfig?.config?.Env ?? [])
  await Deno.writeTextFile(path.join(into, "image-env"), envFile(env))

  const rootfs = path.join(into, "rootfs.erofs")
  const compression = config.images.compression
  await pipe(
    {
      cmd: config.craneBin,
      args: ["export", "--platform", PLATFORM, ref, "-"],
    },
    {
      cmd: "mkfs.erofs",
      args: [
        "--tar=f",
        ...(compression ? [`-z${compression}`] : []),
        rootfs,
      ],
    },
  )
  await Deno.chmod(rootfs, 0o644)
  await verifyRootfs(rootfs)
}

/** The image refs the pools boot, each once. */
export function poolImages(config: Config): string[] {
  return [...new Set(config.pools.map((p) => p.image))]
}

/**
 * Bring the kernel and every pool's image up to date. A failure on one
 * leaves the others to be tried, and the run fails at the end.
 */
export async function updateAll(config: Config): Promise<void> {
  const lockPath = path.join(config.stateDir, "images.lock")
  await Deno.mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  using lock = await Deno.open(lockPath, { create: true, write: true })
  await lock.lock(true)

  const jobs: { label: string; fn: () => Promise<boolean> }[] = [
    {
      label: config.kernel.ref,
      fn: () =>
        update(
          config,
          kernelDir(config),
          config.kernel.ref,
          (ref, into) => buildKernel(config, ref, into),
        ),
    },
    ...poolImages(config).map((ref) => ({
      label: ref,
      fn: () =>
        update(
          config,
          imageDir(config, ref),
          ref,
          (pinnedRef, into) => buildImage(config, pinnedRef, into),
        ),
    })),
  ]

  const failures: string[] = []
  for (const job of jobs) {
    try {
      if (!(await job.fn())) logger.info(`${job.label}: up to date`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logger.error(`${job.label}: ${msg}`)
      failures.push(job.label)
    }
  }
  if (failures.length > 0) {
    throw new Error(`could not update ${failures.join(", ")}`)
  }
}
