import { deepStrictEqual, strictEqual, throws } from "node:assert/strict"
import * as path from "@std/path"
import { ConfigError, defaultVcpus, parseConfig, parseSize } from "./config.ts"

const MINIMAL = `
[pools.linux]
image = "ghcr.io/divvun/divvun-actions:ubuntu-latest"
count = 2
memory = "24G"
tags = ["queue=linux"]
`

Deno.test("sizes are binary units", () => {
  strictEqual(parseSize("24G", "x"), 24 * 1024 ** 3)
  strictEqual(parseSize("512M", "x"), 512 * 1024 ** 2)
  strictEqual(parseSize("1.5T", "x"), 1.5 * 1024 ** 4)
  strictEqual(parseSize("64GiB", "x"), 64 * 1024 ** 3)
  throws(() => parseSize("lots", "x"), ConfigError)
  throws(() => parseSize("0G", "x"), ConfigError)
})

Deno.test("default vCPUs are what Firecracker accepts", () => {
  strictEqual(defaultVcpus(1), 1)
  strictEqual(defaultVcpus(3), 2)
  strictEqual(defaultVcpus(24), 24)
  strictEqual(defaultVcpus(128), 32)
})

Deno.test("a minimal config takes every default", () => {
  const config = parseConfig(MINIMAL, "/etc/divvun-fc/config.toml", 16)
  strictEqual(config.stateDir, "/var/lib/divvun-fc")
  strictEqual(config.network.subnet, "172.30.0.0/16")
  deepStrictEqual(config.network.dns, [])
  strictEqual(config.images.compression, "lz4")
  strictEqual(config.cache.resetOnImageChange, true)
  const [pool] = config.pools
  strictEqual(pool.vcpus, 16)
  strictEqual(pool.memoryMib, 24 * 1024)
  strictEqual(pool.ioEngine, "Sync")
})

Deno.test("slots are numbered across pools in file order", () => {
  const config = parseConfig(
    MINIMAL + `
[pools.alpine]
image = "ghcr.io/divvun/divvun-actions:alpine-latest"
count = 1
memory = "16G"
tags = "queue=alpine"
`,
    "c.toml",
    8,
  )
  deepStrictEqual(
    config.slots.map((s) => [s.name, s.index]),
    [["linux-1", 0], ["linux-2", 1], ["alpine-1", 2]],
  )
  deepStrictEqual(config.pools[1].tags, ["queue=alpine"])
})

Deno.test("an odd vCPU count is refused", () => {
  throws(
    () => parseConfig(MINIMAL + "vcpus = 3\n", "c.toml", 8),
    /1 or an even number/,
  )
})

Deno.test("pool names must fit a hostname and the jailer id", () => {
  throws(
    () => parseConfig(MINIMAL.replace("pools.linux", "pools.Linux"), "c", 8),
    ConfigError,
  )
})

Deno.test("a pool without tags is refused", () => {
  throws(
    () =>
      parseConfig(
        MINIMAL.replace('tags = ["queue=linux"]', ""),
        "c.toml",
        8,
      ),
    /at least the queue/,
  )
})

Deno.test("the example config parses", async () => {
  const file = path.fromFileUrl(
    new URL("../config.example.toml", import.meta.url),
  )
  const config = parseConfig(await Deno.readTextFile(file), file, 8)
  deepStrictEqual(config.slots.map((s) => s.name), [
    "linux-1",
    "linux-2",
    "linux-3",
    "linux-4",
  ])
})
