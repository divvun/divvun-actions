import logger from "~/util/log.ts"
import { run, succeeds } from "./cmd.ts"
import type { Config } from "./config.ts"

/** Every slot's tap starts with this; the firewall matches on it. */
export const TAP_PREFIX = "fctap"
const NFT_TABLE = "divvun_fc"

export type SlotAddress = {
  tap: string
  hostIp: string
  guestIp: string
  netmask: string
  guestMac: string
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number)
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    throw new Error(`not an IPv4 address: ${ip}`)
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) +
    parts[3]
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")
}

export function parseSubnet(cidr: string): { base: number; size: number } {
  const [ip, bitsText] = cidr.split("/")
  const bits = Number(bitsText)
  if (!Number.isInteger(bits) || bits < 8 || bits > 30) {
    throw new Error(`network.subnet: need a prefix of /8 to /30, got ${cidr}`)
  }
  const size = 2 ** (32 - bits)
  const base = ipToInt(ip)
  if (base % size !== 0) {
    throw new Error(`network.subnet: ${cidr} is not aligned to its prefix`)
  }
  return { base, size }
}

/**
 * Slot `index` gets the `index`th /30 of the subnet: host side .1, guest .2.
 * Point-to-point links keep the guests off each other's segment.
 */
export function slotAddress(subnet: string, index: number): SlotAddress {
  const { base, size } = parseSubnet(subnet)
  const block = base + index * 4
  if (index < 0 || block + 4 > base + size) {
    throw new Error(
      `network.subnet ${subnet} has room for ${size / 4} slots, not ${
        index + 1
      }`,
    )
  }
  const guest = block + 2
  const mac = [
    0x06,
    0x00,
    guest >>> 24,
    (guest >>> 16) & 255,
    (guest >>> 8) &
    255,
    guest & 255,
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":")
  return {
    tap: `${TAP_PREFIX}${index}`,
    hostIp: intToIp(block + 1),
    guestIp: intToIp(guest),
    netmask: "255.255.255.252",
    guestMac: mac,
  }
}

/**
 * The firewall the microVMs need: masquerade out of the host, no traffic
 * between guests, and no connections from a guest to the host itself.
 * Replaced whole on every run so it never accumulates.
 */
export function nftRuleset(subnet: string): string {
  return `table ip ${NFT_TABLE}
delete table ip ${NFT_TABLE}
table ip ${NFT_TABLE} {
  chain forward {
    type filter hook forward priority filter; policy accept;
    iifname "${TAP_PREFIX}*" oifname "${TAP_PREFIX}*" drop
  }
  chain input {
    type filter hook input priority filter; policy accept;
    iifname "${TAP_PREFIX}*" ct state established,related accept
    iifname "${TAP_PREFIX}*" drop
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr ${subnet} oifname != "${TAP_PREFIX}*" masquerade
  }
}
`
}

/**
 * Docker on the same host sets the iptables FORWARD policy to DROP, which
 * overrides an accept in any other table. DOCKER-USER is where Docker lets
 * other forwarding in.
 */
const DOCKER_USER_RULES = [
  ["-i", `${TAP_PREFIX}+`, "-j", "ACCEPT"],
  [
    "-o",
    `${TAP_PREFIX}+`,
    "-m",
    "conntrack",
    "--ctstate",
    "RELATED,ESTABLISHED",
    "-j",
    "ACCEPT",
  ],
]

export async function networkUp(config: Config): Promise<void> {
  parseSubnet(config.network.subnet)
  await Deno.writeTextFile("/proc/sys/net/ipv4/ip_forward", "1\n")
  await run("nft", ["-f", "-"], { stdin: nftRuleset(config.network.subnet) })

  if (await succeeds("iptables", ["-n", "-L", "DOCKER-USER"])) {
    for (const rule of DOCKER_USER_RULES) {
      if (!(await succeeds("iptables", ["-C", "DOCKER-USER", ...rule]))) {
        await run("iptables", ["-I", "DOCKER-USER", ...rule])
      }
    }
    logger.info("Let microVM traffic through Docker's DOCKER-USER chain")
  }
  logger.info(`Host networking up for ${config.network.subnet}`)
}

export async function networkDown(): Promise<void> {
  await run("nft", ["delete", "table", "ip", NFT_TABLE], { okCodes: [1] })
  if (await succeeds("iptables", ["-n", "-L", "DOCKER-USER"])) {
    for (const rule of DOCKER_USER_RULES) {
      while (await succeeds("iptables", ["-C", "DOCKER-USER", ...rule])) {
        await run("iptables", ["-D", "DOCKER-USER", ...rule])
      }
    }
  }
}

/** Recreate the slot's tap, owned by its jail uid so Firecracker can open it. */
export async function tapUp(addr: SlotAddress, uid: number): Promise<void> {
  await tapDown(addr)
  await run("ip", [
    "tuntap",
    "add",
    "dev",
    addr.tap,
    "mode",
    "tap",
    "user",
    String(uid),
  ])
  await run("ip", ["addr", "add", `${addr.hostIp}/30`, "dev", addr.tap])
  await run("ip", ["link", "set", addr.tap, "up"])
}

export async function tapDown(addr: SlotAddress): Promise<void> {
  if (await succeeds("ip", ["link", "show", addr.tap])) {
    await run("ip", ["link", "del", addr.tap])
  }
}

/** The host's own upstream resolvers, which the guests can reach via NAT. */
export async function hostResolvers(): Promise<string[]> {
  for (
    const file of ["/run/systemd/resolve/resolv.conf", "/etc/resolv.conf"]
  ) {
    let text: string
    try {
      text = await Deno.readTextFile(file)
    } catch {
      continue
    }
    const servers = text.split("\n")
      .map((l) => l.trim().match(/^nameserver\s+(\d+\.\d+\.\d+\.\d+)\s*$/))
      .filter((m): m is RegExpMatchArray => m != null)
      .map((m) => m[1])
      .filter((ip) => !ip.startsWith("127."))
    if (servers.length > 0) return servers.slice(0, 2)
  }
  throw new Error(
    "found no IPv4 nameserver outside 127.0.0.0/8 on the host; set network.dns",
  )
}
