import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict"
import { parseConfig } from "./config.ts"
import { nftRuleset, slotAddress } from "./net.ts"
import {
  bootArgs,
  envFile,
  firecrackerConfig,
  guestHostname,
  imageEnv,
  shellQuote,
} from "./vm.ts"
import { renderUnits } from "./systemd.ts"

const CONFIG = parseConfig(
  `
[pools.linux]
image = "ghcr.io/divvun/divvun-actions:ubuntu-latest"
count = 4
memory = "24G"
tags = ["queue=linux", "size=large"]
`,
  "c.toml",
  16,
)

Deno.test("each slot gets its own /30", () => {
  deepStrictEqual(slotAddress("172.30.0.0/16", 0), {
    tap: "fctap0",
    hostIp: "172.30.0.1",
    guestIp: "172.30.0.2",
    netmask: "255.255.255.252",
    guestMac: "06:00:ac:1e:00:02",
  })
  const far = slotAddress("172.30.0.0/16", 100)
  strictEqual(far.hostIp, "172.30.1.145")
  strictEqual(far.guestIp, "172.30.1.146")
  strictEqual(far.tap, "fctap100")
})

Deno.test("a subnet too small for the slots is refused", () => {
  slotAddress("10.9.0.0/29", 1)
  throws(() => slotAddress("10.9.0.0/29", 2), /room for 2 slots/)
  throws(() => slotAddress("10.9.0.1/24", 0), /not aligned/)
})

Deno.test("the firewall replaces its own table and only that", () => {
  const rules = nftRuleset("172.30.0.0/16")
  ok(rules.startsWith("table ip divvun_fc\ndelete table ip divvun_fc\n"))
  ok(rules.includes('iifname "fctap*" oifname "fctap*" drop'))
  ok(rules.includes('ip saddr 172.30.0.0/16 oifname != "fctap*" masquerade'))
})

Deno.test("guest hostnames are one valid label", () => {
  strictEqual(guestHostname("Build01.uit.no", "linux-2"), "build01-linux-2")
  const long = guestHostname("x".repeat(80), "linux-large-12")
  strictEqual(long.length, 63)
  ok(long.endsWith("-linux-large-12"))
})

Deno.test("the kernel configures the network itself", () => {
  const args = bootArgs({
    addr: slotAddress("172.30.0.0/16", 1),
    hostname: "build01-linux-2",
    dns: ["192.168.1.1", "1.1.1.1"],
    extraArgs: "quiet",
  })
  ok(
    args.includes(
      "ip=172.30.0.6::172.30.0.5:255.255.255.252:build01-linux-2:eth0:off:192.168.1.1:1.1.1.1",
    ),
  )
  ok(args.includes("init=/usr/local/sbin/divvun-vm-init"))
  ok(args.includes("rootfstype=erofs"))
  ok(args.endsWith(" quiet"))
})

Deno.test("the VM gets the image read-only and the disks it writes", () => {
  const slot = CONFIG.slots[1]
  const addr = slotAddress(CONFIG.network.subnet, slot.index)
  const vm = firecrackerConfig({ slot, addr, bootArgs: "console=ttyS0" }) as {
    drives: Record<string, unknown>[]
    "machine-config": Record<string, unknown>
    "network-interfaces": Record<string, unknown>[]
  }
  deepStrictEqual(vm.drives.map((d) => [d.drive_id, d.is_read_only]), [
    ["rootfs", true],
    ["scratch", false],
    ["cache", false],
    ["config", true],
  ])
  strictEqual(vm.drives[0].is_root_device, true)
  strictEqual(vm.drives[1].discard, true)
  strictEqual(vm.drives[2].cache_type, "Writeback")
  deepStrictEqual(vm["machine-config"], {
    vcpu_count: 16,
    mem_size_mib: 24 * 1024,
    smt: false,
  })
  strictEqual(vm["network-interfaces"][0].host_dev_name, "fctap1")
})

Deno.test("discard is only asked of the Sync engine", () => {
  const slot = {
    ...CONFIG.slots[0],
    pool: { ...CONFIG.pools[0], ioEngine: "Async" as const },
  }
  const vm = firecrackerConfig({
    slot,
    addr: slotAddress(CONFIG.network.subnet, 0),
    bootArgs: "",
  }) as { drives: Record<string, unknown>[] }
  strictEqual(vm.drives[1].discard, undefined)
  strictEqual(vm.drives[1].io_engine, "Async")
})

Deno.test("env files survive any value a shell could choke on", () => {
  strictEqual(shellQuote("it's $HOME `x`"), `'it'\\''s $HOME \`x\`'`)
  strictEqual(
    envFile({ PATH: "/root/.cargo/bin:/usr/bin", "NOT-VALID": "x", A_1: "" }),
    "PATH='/root/.cargo/bin:/usr/bin'\nA_1=''\n",
  )
})

Deno.test("the image's ENV comes through as Docker would set it", () => {
  deepStrictEqual(
    imageEnv(["PATH=/a:/b", "EMPTY=", "WITH_EQ=a=b", "BROKEN"]),
    { PATH: "/a:/b", EMPTY: "", WITH_EQ: "a=b" },
  )
})

Deno.test("units run this checkout with the host's config", () => {
  const units = renderUnits({
    deno: "/usr/local/bin/deno",
    repo: "/opt/divvun-actions",
    cli: "/opt/divvun-actions/firecracker/cli.ts",
    configPath: "/etc/divvun-fc/config.toml",
  })
  deepStrictEqual(Object.keys(units).sort(), [
    "divvun-fc-images.service",
    "divvun-fc-images.timer",
    "divvun-fc-network.service",
    "divvun-fc@.service",
  ])
  ok(
    units["divvun-fc@.service"].includes(
      "/opt/divvun-actions/firecracker/cli.ts --config /etc/divvun-fc/config.toml slot run %i",
    ),
  )
  ok(units["divvun-fc@.service"].includes("TimeoutStopSec=infinity"))
  for (const [name, text] of Object.entries(units)) {
    if (name.endsWith(".service")) {
      ok(text.includes("WorkingDirectory=/opt/divvun-actions\n"), name)
    }
  }
})
