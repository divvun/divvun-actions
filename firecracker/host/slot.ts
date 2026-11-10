import * as path from "@std/path"
import { walk } from "@std/fs/walk"
import logger from "~/util/log.ts"
import { run, succeeds } from "./cmd.ts"
import type { Config, Slot } from "./config.ts"
import { currentVersion, imageDir, kernelDir, type Version } from "./images.ts"
import {
  hostResolvers,
  type SlotAddress,
  slotAddress,
  tapDown,
  tapUp,
} from "./net.ts"
import {
  agentEnv,
  bootArgs,
  DRIVE_LABELS,
  envFile,
  firecrackerConfig,
  guestHostname,
  JAIL_FILES,
} from "./vm.ts"

const MIB = 1024 ** 2
const WAIT_FOR_IMAGES_MS = 30_000
const CTRL_ALT_DEL_EVERY_MS = 10_000
const BACKOFF_MIN_MS = 5_000
const BACKOFF_MAX_MS = 5 * 60_000

export function slotUid(config: Config, slot: Slot): number {
  return config.uidBase + slot.index
}

export function cachePaths(config: Config, slot: Slot) {
  const dir = path.join(config.stateDir, "cache")
  return {
    dir,
    disk: path.join(dir, `${slot.name}.ext4`),
    /** The image ref the disk was made under, for reset_on_image_change. */
    marker: path.join(dir, `${slot.name}.image`),
  }
}

/** `<chroot-base>/<exec-file-name>/<id>/root`, as the jailer lays it out. */
function jailPaths(config: Config, slot: Slot) {
  const base = path.join(config.stateDir, "jail")
  const idDir = path.join(base, path.basename(config.firecrackerBin), slot.name)
  return { base, idDir, root: path.join(idDir, "root") }
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p)
    return true
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false
    throw e
  }
}

async function makeExt4(
  file: string,
  bytes: number,
  label: string,
  extra: string[] = [],
): Promise<void> {
  const f = await Deno.open(file, { create: true, write: true, truncate: true })
  try {
    await f.truncate(bytes)
  } finally {
    f.close()
  }
  await run("mkfs.ext4", [
    "-q",
    "-F",
    "-m",
    "0",
    "-L",
    label,
    "-E",
    "lazy_itable_init=1,lazy_journal_init=1,nodiscard",
    ...extra,
    file,
  ])
}

async function ext4Usage(file: string): Promise<number> {
  const out = (await run("dumpe2fs", ["-h", file])).stdout
  const field = (name: string) => {
    const m = out.match(new RegExp(`^${name}:\\s+(\\d+)$`, "m"))
    if (!m) throw new Error(`dumpe2fs -h ${file} has no "${name}"`)
    return Number(m[1])
  }
  const total = field("Block count")
  return total === 0 ? 1 : 1 - field("Free blocks") / total
}

/** Why the slot's cache disk has to be made afresh, or null to keep it. */
async function cacheResetReason(
  config: Config,
  slot: Slot,
  image: Version,
): Promise<string | null> {
  const { disk, marker } = cachePaths(config, slot)
  if (!(await exists(disk))) return "there is none yet"
  if ((await Deno.stat(disk)).size !== slot.pool.cacheBytes) {
    return "its configured size changed"
  }
  if (config.cache.resetOnImageChange) {
    const made = await Deno.readTextFile(marker).catch(() => "")
    if (made.trim() !== image.ref) return `the image is now ${image.ref}`
  }
  // 1 and 2 mean e2fsck repaired the filesystem.
  const fsck = await run("e2fsck", ["-p", disk], { okCodes: [1, 2, 4, 8] })
  if (fsck.code >= 4) return `e2fsck could not repair it: ${fsck.stdout}`
  const usage = await ext4Usage(disk)
  if (usage >= config.cache.resetUsage) {
    return `it is ${Math.round(usage * 100)}% full`
  }
  return null
}

async function prepareCache(config: Config, slot: Slot, image: Version) {
  const { dir, disk, marker } = cachePaths(config, slot)
  await Deno.mkdir(dir, { recursive: true })
  const reason = await cacheResetReason(config, slot, image)
  if (reason != null) {
    logger.info(`Making a new cache disk for ${slot.name}: ${reason}`)
    await Deno.remove(disk).catch(() => {})
    await makeExt4(disk, slot.pool.cacheBytes, DRIVE_LABELS.cache)
    await Deno.writeTextFile(marker, image.ref + "\n")
  }
}

async function copyDirInto(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true })
  if (await exists(src)) {
    await run("cp", ["-a", `${src}/.`, dest])
  } else {
    logger.warning(`${src} does not exist; the guest gets an empty ${dest}`)
  }
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0
  for await (const entry of walk(dir, { includeDirs: false })) {
    total += (await Deno.lstat(entry.path)).size
  }
  return total
}

/** The read-only drive docker/vm-init.sh reads its whole setup from. */
async function makeConfigDisk(opts: {
  config: Config
  slot: Slot
  file: string
  hostname: string
  image: Version
  kernel: Version
}): Promise<void> {
  const { config, slot } = opts
  const token = (await Deno.readTextFile(config.buildkite.tokenFile)).trim()
  if (!token) throw new Error(`${config.buildkite.tokenFile} is empty`)

  const staging = await Deno.makeTempDir({ prefix: `divvun-fc-${slot.name}-` })
  try {
    await Deno.chmod(staging, 0o700)
    await Deno.writeTextFile(
      path.join(staging, "env"),
      envFile(agentEnv({ token, slot, hostname: opts.hostname })),
      { mode: 0o600 },
    )
    await Deno.copyFile(
      path.join(opts.image.dir, "image-env"),
      path.join(staging, "image-env"),
    )
    await Deno.writeTextFile(
      path.join(staging, "microvm"),
      [
        `slot ${slot.name}`,
        `host ${Deno.hostname()}`,
        `image ${opts.image.ref}`,
        `kernel ${opts.kernel.ref}`,
        "",
      ].join("\n"),
    )
    await copyDirInto(config.buildkite.hooksDir, path.join(staging, "hooks"))
    await copyDirInto(
      config.buildkite.secretsDir,
      path.join(staging, "secrets"),
    )
    if (config.buildkite.dockerConfig) {
      const dest = path.join(staging, "docker-config.json")
      await Deno.copyFile(config.buildkite.dockerConfig, dest)
      await Deno.chmod(dest, 0o600)
    }

    const bytes = Math.max(32 * MIB, 2 * (await dirBytes(staging)) + 16 * MIB)
    await makeExt4(opts.file, bytes, DRIVE_LABELS.config, ["-d", staging])
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
}

type Boot = {
  addr: SlotAddress
  jail: ReturnType<typeof jailPaths>
  args: string[]
}

async function prepareBoot(
  config: Config,
  slot: Slot,
  kernel: Version,
  image: Version,
): Promise<Boot> {
  const uid = slotUid(config, slot)
  const jail = jailPaths(config, slot)
  const addr = slotAddress(config.network.subnet, slot.index)
  const hostname = guestHostname(Deno.hostname(), slot.name)
  const dns = config.network.dns.length > 0
    ? config.network.dns
    : await hostResolvers()

  await Deno.remove(jail.idDir, { recursive: true }).catch(() => {})
  await Deno.mkdir(jail.root, { recursive: true })
  const inJail = (name: string) => path.join(jail.root, name)

  try {
    await Deno.link(path.join(kernel.dir, "vmlinux"), inJail(JAIL_FILES.kernel))
    await Deno.link(
      path.join(image.dir, "rootfs.erofs"),
      inJail(JAIL_FILES.rootfs),
    )
  } catch (e) {
    throw new Error(
      `could not hard-link the kernel and image into ${jail.root}; ` +
        `${config.stateDir} must be one filesystem`,
      { cause: e },
    )
  }

  await makeExt4(
    inJail(JAIL_FILES.scratch),
    slot.pool.scratchBytes,
    DRIVE_LABELS.scratch,
  )
  await Deno.chown(inJail(JAIL_FILES.scratch), uid, uid)

  await prepareCache(config, slot, image)
  const { disk } = cachePaths(config, slot)
  await Deno.chown(disk, uid, uid)
  await Deno.link(disk, inJail(JAIL_FILES.cache))

  await makeConfigDisk({
    config,
    slot,
    file: inJail(JAIL_FILES.config),
    hostname,
    image,
    kernel,
  })
  await Deno.chown(inJail(JAIL_FILES.config), uid, uid)
  await Deno.chmod(inJail(JAIL_FILES.config), 0o400)

  const vmConfig = firecrackerConfig({
    slot,
    addr,
    bootArgs: bootArgs({
      addr,
      hostname,
      dns,
      extraArgs: config.kernel.extraArgs,
    }),
  })
  await Deno.writeTextFile(
    inJail(JAIL_FILES.vmConfig),
    JSON.stringify(vmConfig, null, 2) + "\n",
  )

  await tapUp(addr, uid)

  // cgroup v2 and no --cgroup: the jailer leaves Firecracker in this unit's
  // cgroup instead of making one of its own outside it.
  const args = [
    "--id",
    slot.name,
    "--exec-file",
    config.firecrackerBin,
    "--uid",
    String(uid),
    "--gid",
    String(uid),
    "--chroot-base-dir",
    jail.base,
    "--cgroup-version",
    "2",
    "--",
    "--config-file",
    `/${JAIL_FILES.vmConfig}`,
    "--api-sock",
    `/${JAIL_FILES.apiSocket}`,
  ]
  logger.info(
    `Booting ${slot.name} as ${hostname}: ${image.ref}, kernel ${kernel.ref}`,
  )
  return { addr, jail, args }
}

async function sendCtrlAltDel(jailRoot: string): Promise<boolean> {
  return await succeeds("curl", [
    "--silent",
    "--fail",
    "--max-time",
    "5",
    "--unix-socket",
    path.join(jailRoot, JAIL_FILES.apiSocket),
    "-X",
    "PUT",
    "http://localhost/actions",
    "-H",
    "Content-Type: application/json",
    "-d",
    '{"action_type":"SendCtrlAltDel"}',
  ])
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

async function waitForVersions(
  config: Config,
  slot: Slot,
  signal: AbortSignal,
): Promise<{ kernel: Version; image: Version } | null> {
  let logged = false
  while (!signal.aborted) {
    const kernel = await currentVersion(kernelDir(config))
    const image = await currentVersion(imageDir(config, slot.pool.image))
    if (kernel && image) return { kernel, image }
    if (!logged) {
      logger.info(
        `Waiting for ${kernel ? slot.pool.image : config.kernel.ref}; ` +
          "the divvun-fc-images timer converts it",
      )
      logged = true
    }
    await sleep(WAIT_FOR_IMAGES_MS, signal)
  }
  return null
}

/**
 * Boot the slot's VM over and over, one Buildkite job each, until told to
 * stop. The first SIGTERM lets the running job finish; a second kills the VM.
 */
export async function runSlot(config: Config, slot: Slot): Promise<void> {
  const stop = new AbortController()
  let child: Deno.ChildProcess | null = null
  let jailRoot: string | null = null
  let nagger: ReturnType<typeof setInterval> | undefined

  const askGuestToStop = (root: string) => {
    logger.info(`${slot.name}: stopping once the running job finishes`)
    // The guest misses it while it is still booting, so keep asking.
    sendCtrlAltDel(root)
    nagger = setInterval(() => sendCtrlAltDel(root), CTRL_ALT_DEL_EVERY_MS)
  }

  const onSignal = () => {
    if (stop.signal.aborted) {
      logger.warning(`${slot.name}: second stop signal, killing the VM`)
      try {
        child?.kill("SIGKILL")
      } catch {
        // Already gone.
      }
      return
    }
    stop.abort()
    if (child && jailRoot) askGuestToStop(jailRoot)
  }
  Deno.addSignalListener("SIGTERM", onSignal)
  Deno.addSignalListener("SIGINT", onSignal)

  let backoff = BACKOFF_MIN_MS
  const failed = async (what: string) => {
    logger.error(`${slot.name}: ${what}; trying again in ${backoff / 1000}s`)
    await sleep(backoff, stop.signal)
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  }

  let addr: SlotAddress | null = null
  try {
    while (!stop.signal.aborted) {
      const versions = await waitForVersions(config, slot, stop.signal)
      if (!versions) break

      let boot: Boot
      try {
        boot = await prepareBoot(config, slot, versions.kernel, versions.image)
      } catch (e) {
        await failed(
          `could not prepare the VM: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
        continue
      }
      addr = boot.addr
      if (stop.signal.aborted) {
        await Deno.remove(boot.jail.idDir, { recursive: true }).catch(() => {})
        break
      }

      child = new Deno.Command(config.jailerBin, {
        args: boot.args,
        stdin: "null",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn()
      jailRoot = boot.jail.root
      const status = await child.status
      child = null
      jailRoot = null
      clearInterval(nagger)
      await Deno.remove(boot.jail.idDir, { recursive: true }).catch(() => {})

      if (status.success) {
        backoff = BACKOFF_MIN_MS
      } else {
        await failed(`Firecracker exited with ${status.code}`)
      }
    }
  } finally {
    clearInterval(nagger)
    Deno.removeSignalListener("SIGTERM", onSignal)
    Deno.removeSignalListener("SIGINT", onSignal)
    if (addr) await tapDown(addr)
  }
  logger.info(`${slot.name}: stopped`)
}
