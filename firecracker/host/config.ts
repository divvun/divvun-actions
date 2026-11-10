import { parse as parseToml } from "@std/toml"
import { KERNEL_IMAGE_REF } from "../versions.ts"

export const DEFAULT_CONFIG_PATH = "/etc/divvun-fc/config.toml"

export type IoEngine = "Sync" | "Async"

export type Pool = {
  name: string
  image: string
  count: number
  vcpus: number
  memoryMib: number
  scratchBytes: number
  cacheBytes: number
  tags: string[]
  ioEngine: IoEngine
}

export type Slot = {
  /** `<pool>-<n>`, n from 1. Also the jailer id and the systemd instance. */
  name: string
  pool: Pool
  /**
   * Position across every pool, in file order. Picks the slot's addresses,
   * tap and uid, so append new pools rather than inserting them.
   */
  index: number
}

export type Config = {
  path: string
  stateDir: string
  firecrackerBin: string
  jailerBin: string
  craneBin: string
  uidBase: number
  buildkite: {
    tokenFile: string
    hooksDir: string
    secretsDir: string
    dockerConfig: string | null
  }
  network: {
    subnet: string
    /** Empty means: take the host's upstream resolvers at boot. */
    dns: string[]
  }
  kernel: {
    ref: string
    extraArgs: string
  }
  images: {
    compression: string | null
  }
  cache: {
    resetOnImageChange: boolean
    /** Recreate the cache disk at boot once it is this full (0-1). */
    resetUsage: number
  }
  pools: Pool[]
  slots: Slot[]
}

const POOL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
/** Leaves room in the jailer id (64) and the guest hostname for `-<n>`. */
const MAX_POOL_NAME = 32
const MAX_VCPUS = 32

export class ConfigError extends Error {}

const UNITS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
}

/** `"24G"` → bytes. Binary units; a trailing `B` or `iB` is accepted. */
export function parseSize(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${field}: expected a size like "24G"`)
  }
  const m = value.trim().toUpperCase().match(
    /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:I?B)?$/,
  )
  if (!m) throw new ConfigError(`${field}: cannot read size "${value}"`)
  const bytes = Math.floor(parseFloat(m[1]) * UNITS[m[2]])
  if (bytes <= 0) throw new ConfigError(`${field}: size must be positive`)
  return bytes
}

/** Firecracker takes 1 or an even number of vCPUs, at most 32. */
export function defaultVcpus(hostCpus: number): number {
  const n = Math.min(MAX_VCPUS, hostCpus)
  return n <= 1 ? 1 : n - (n % 2)
}

type Table = Record<string, unknown>

function table(value: unknown, field: string): Table {
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${field}: expected a table`)
  }
  return value as Table
}

function str(t: Table, key: string, field: string, fallback?: string): string {
  const v = t[key]
  if (v == null) {
    if (fallback !== undefined) return fallback
    throw new ConfigError(`${field}.${key} is required`)
  }
  if (typeof v !== "string" || v === "") {
    throw new ConfigError(`${field}.${key}: expected a non-empty string`)
  }
  return v
}

function optStr(t: Table, key: string, field: string): string | null {
  return t[key] == null ? null : str(t, key, field)
}

function int(t: Table, key: string, field: string, fallback?: number): number {
  const v = t[key]
  if (v == null) {
    if (fallback !== undefined) return fallback
    throw new ConfigError(`${field}.${key} is required`)
  }
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new ConfigError(`${field}.${key}: expected an integer`)
  }
  return v
}

function bool(t: Table, key: string, field: string, fallback: boolean) {
  const v = t[key]
  if (v == null) return fallback
  if (typeof v !== "boolean") {
    throw new ConfigError(`${field}.${key}: expected true or false`)
  }
  return v
}

function strings(t: Table, key: string, field: string): string[] {
  const v = t[key]
  if (v == null) return []
  if (typeof v === "string") return v.split(",").map((s) => s.trim())
  if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v
  throw new ConfigError(`${field}.${key}: expected a list of strings`)
}

function parsePool(name: string, value: unknown, hostCpus: number): Pool {
  const field = `pools.${name}`
  if (!POOL_NAME.test(name) || name.length > MAX_POOL_NAME) {
    throw new ConfigError(
      `${field}: pool names are up to ${MAX_POOL_NAME} lowercase letters, digits and single hyphens`,
    )
  }
  const t = table(value, field)
  const count = int(t, "count", field)
  if (count < 0) throw new ConfigError(`${field}.count must be 0 or more`)

  const vcpus = int(t, "vcpus", field, defaultVcpus(hostCpus))
  if (vcpus < 1 || vcpus > MAX_VCPUS || (vcpus > 1 && vcpus % 2 !== 0)) {
    throw new ConfigError(
      `${field}.vcpus: Firecracker takes 1 or an even number up to ${MAX_VCPUS}`,
    )
  }

  const ioEngine = str(t, "io_engine", field, "Sync")
  if (ioEngine !== "Sync" && ioEngine !== "Async") {
    throw new ConfigError(`${field}.io_engine: "Sync" or "Async"`)
  }

  const tags = strings(t, "tags", field)
  if (tags.length === 0) {
    throw new ConfigError(
      `${field}.tags: give at least the queue, e.g. ["queue=linux"]`,
    )
  }

  return {
    name,
    image: str(t, "image", field),
    count,
    vcpus,
    memoryMib: Math.floor(parseSize(t.memory, `${field}.memory`) / 1024 ** 2),
    scratchBytes: parseSize(t.scratch ?? "64G", `${field}.scratch`),
    cacheBytes: parseSize(t.cache ?? "200G", `${field}.cache`),
    tags,
    ioEngine,
  }
}

export function parseConfig(
  text: string,
  path: string,
  hostCpus: number,
): Config {
  let raw: Table
  try {
    raw = parseToml(text) as Table
  } catch (e) {
    throw new ConfigError(
      `${path}: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  const bk = table(raw.buildkite, "buildkite")
  const net = table(raw.network, "network")
  const kernel = table(raw.kernel, "kernel")
  const images = table(raw.images, "images")
  const cache = table(raw.cache, "cache")
  const bins = table(raw.bin, "bin")

  const poolTable = table(raw.pools, "pools")
  const pools = Object.entries(poolTable).map(([name, value]) =>
    parsePool(name, value, hostCpus)
  )
  if (pools.length === 0) {
    throw new ConfigError(`${path}: no [pools.<name>] tables`)
  }

  const slots: Slot[] = []
  for (const pool of pools) {
    for (let n = 1; n <= pool.count; n++) {
      slots.push({ name: `${pool.name}-${n}`, pool, index: slots.length })
    }
  }

  const compression = str(images, "compression", "images", "lz4")
  const resetUsage = cache.reset_usage ?? 0.9
  if (
    typeof resetUsage !== "number" || !(resetUsage > 0 && resetUsage <= 1)
  ) {
    throw new ConfigError("cache.reset_usage: a fraction between 0 and 1")
  }

  return {
    path,
    stateDir: str(raw, "state_dir", "config", "/var/lib/divvun-fc"),
    firecrackerBin: str(
      bins,
      "firecracker",
      "bin",
      "/usr/local/bin/firecracker",
    ),
    jailerBin: str(bins, "jailer", "bin", "/usr/local/bin/jailer"),
    craneBin: str(bins, "crane", "bin", "/usr/local/bin/crane"),
    uidBase: int(raw, "uid_base", "config", 900000),
    buildkite: {
      tokenFile: str(
        bk,
        "token_file",
        "buildkite",
        "/etc/divvun-fc/agent-token",
      ),
      hooksDir: str(bk, "hooks_dir", "buildkite", "/var/lib/buildkite/hooks"),
      secretsDir: str(
        bk,
        "secrets_dir",
        "buildkite",
        "/var/lib/buildkite-secrets",
      ),
      dockerConfig: optStr(bk, "docker_config", "buildkite"),
    },
    network: {
      subnet: str(net, "subnet", "network", "172.30.0.0/16"),
      dns: strings(net, "dns", "network"),
    },
    kernel: {
      ref: str(kernel, "ref", "kernel", KERNEL_IMAGE_REF),
      extraArgs: str(kernel, "extra_args", "kernel", "quiet"),
    },
    images: {
      compression: compression === "none" ? null : compression,
    },
    cache: {
      resetOnImageChange: bool(cache, "reset_on_image_change", "cache", true),
      resetUsage,
    },
    pools,
    slots,
  }
}

export async function loadConfig(path = DEFAULT_CONFIG_PATH): Promise<Config> {
  let text: string
  try {
    text = await Deno.readTextFile(path)
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new ConfigError(
        `${path} does not exist; start from firecracker/config.example.toml`,
      )
    }
    throw e
  }
  return parseConfig(text, path, navigator.hardwareConcurrency)
}

export function findSlot(config: Config, name: string): Slot {
  const slot = config.slots.find((s) => s.name === name)
  if (!slot) {
    throw new ConfigError(
      `no slot ${name} in ${config.path}; slots: ${
        config.slots.map((s) => s.name).join(", ")
      }`,
    )
  }
  return slot
}
