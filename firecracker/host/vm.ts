import type { Slot } from "./config.ts"
import type { SlotAddress } from "./net.ts"

/**
 * The ext4 labels docker/vm-init.sh mounts the drives by. Labels rather
 * than /dev/vdX, so nothing depends on the order Firecracker attaches
 * drives in.
 */
export const DRIVE_LABELS = {
  scratch: "divvun-scratch",
  cache: "divvun-cache",
  config: "divvun-config",
} as const

export const GUEST_INIT = "/usr/local/sbin/divvun-vm-init"

/** Paths as the jailed Firecracker sees them, i.e. relative to its chroot. */
export const JAIL_FILES = {
  kernel: "vmlinux",
  rootfs: "rootfs.erofs",
  scratch: "scratch.ext4",
  cache: "cache.ext4",
  config: "config.ext4",
  vmConfig: "vm.json",
  apiSocket: "firecracker.socket",
} as const

const HOSTNAME_MAX = 63

/** `<host>-<slot>`, which is also the agent's name in Buildkite. */
export function guestHostname(hostname: string, slot: string): string {
  const host = hostname.split(".")[0].toLowerCase().replace(/[^a-z0-9-]/g, "-")
  const room = HOSTNAME_MAX - slot.length - 1
  return `${host.slice(0, Math.max(0, room)).replace(/-+$/, "")}-${slot}`
}

export function bootArgs(opts: {
  addr: SlotAddress
  hostname: string
  dns: string[]
  extraArgs: string
}): string {
  const [dns0 = "", dns1 = ""] = opts.dns
  const ip = [
    opts.addr.guestIp,
    "",
    opts.addr.hostIp,
    opts.addr.netmask,
    opts.hostname,
    "eth0",
    "off",
    dns0,
    dns1,
  ].join(":")
  return [
    "console=ttyS0",
    "reboot=k",
    "panic=1",
    // Firecracker's advice: skip probing the i8042, which SendCtrlAltDel
    // still works through.
    "i8042.noaux",
    "i8042.nomux",
    "i8042.nopnp",
    "i8042.dumbkbd",
    "rootfstype=erofs",
    `init=${GUEST_INIT}`,
    `ip=${ip}`,
    opts.extraArgs,
  ].filter((a) => a !== "").join(" ")
}

export function firecrackerConfig(opts: {
  slot: Slot
  addr: SlotAddress
  bootArgs: string
}): unknown {
  const { pool } = opts.slot
  const sync = pool.ioEngine === "Sync"
  // Firecracker can only pass discards through on the Sync engine.
  const writable = (id: string, path: string, cacheType: string) => ({
    drive_id: id,
    path_on_host: `/${path}`,
    is_root_device: false,
    is_read_only: false,
    cache_type: cacheType,
    io_engine: pool.ioEngine,
    ...(sync ? { discard: true } : {}),
  })
  return {
    "boot-source": {
      kernel_image_path: `/${JAIL_FILES.kernel}`,
      boot_args: opts.bootArgs,
    },
    drives: [
      {
        drive_id: "rootfs",
        path_on_host: `/${JAIL_FILES.rootfs}`,
        is_root_device: true,
        is_read_only: true,
      },
      // Thrown away after the boot, so flushes can be skipped.
      writable("scratch", JAIL_FILES.scratch, "Unsafe"),
      writable("cache", JAIL_FILES.cache, "Writeback"),
      {
        drive_id: "config",
        path_on_host: `/${JAIL_FILES.config}`,
        is_root_device: false,
        is_read_only: true,
      },
    ],
    "machine-config": {
      vcpu_count: pool.vcpus,
      mem_size_mib: pool.memoryMib,
      smt: false,
    },
    "network-interfaces": [
      {
        iface_id: "eth0",
        host_dev_name: opts.addr.tap,
        guest_mac: opts.addr.guestMac,
      },
    ],
    entropy: {},
  }
}

/** Single-quoted for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * A file the guest sources with `set -a`. Names that are not valid shell
 * identifiers are dropped, since sourcing them would fail the boot.
 */
export function envFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shellQuote(v)}\n`)
    .join("")
}

/** `KEY=value` strings, as in an OCI image config's `Env`. */
export function imageEnv(env: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of env) {
    const eq = entry.indexOf("=")
    if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return out
}

export function agentEnv(opts: {
  token: string
  slot: Slot
  hostname: string
}): Record<string, string> {
  return {
    BUILDKITE_AGENT_TOKEN: opts.token,
    BUILDKITE_AGENT_NAME: opts.hostname,
    BUILDKITE_AGENT_TAGS: opts.slot.pool.tags.join(","),
  }
}
