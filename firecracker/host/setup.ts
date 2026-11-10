import * as path from "@std/path"
import { encodeHex } from "@std/encoding/hex"
import logger from "~/util/log.ts"
import { run, succeeds } from "./cmd.ts"
import { DEFAULT_CONFIG_PATH } from "./config.ts"
import { fcVersions } from "../versions.ts"

const BIN_DIR = "/usr/local/bin"
const APT_PACKAGES = [
  "curl",
  "e2fsprogs",
  "erofs-utils",
  "iproute2",
  "nftables",
]

async function download(url: string, sha256: string): Promise<Uint8Array> {
  logger.info(`Downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  const actual = encodeHex(await crypto.subtle.digest("SHA-256", data))
  if (actual !== sha256) {
    throw new Error(`${url}: sha256 is ${actual}, versions.ts pins ${sha256}`)
  }
  return data
}

async function installedVersion(bin: string, args: string[]) {
  try {
    return (await run(bin, args)).stdout
  } catch {
    return ""
  }
}

/** Unpack a release tarball and install the named members as `BIN_DIR/<as>`. */
async function installFromTarball(
  data: Uint8Array,
  members: { from: string; as: string }[],
): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "divvun-fc-setup-" })
  try {
    const tarball = path.join(tmp, "release.tgz")
    await Deno.writeFile(tarball, data)
    await run("tar", ["-xzf", tarball, "-C", tmp])
    for (const m of members) {
      const dest = path.join(BIN_DIR, m.as)
      await Deno.copyFile(path.join(tmp, m.from), `${dest}.new`)
      await Deno.chmod(`${dest}.new`, 0o755)
      await Deno.rename(`${dest}.new`, dest)
      logger.info(`Installed ${dest}`)
    }
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
}

async function installFirecracker() {
  const { version, sha256 } = fcVersions.firecracker
  const have = await installedVersion(path.join(BIN_DIR, "firecracker"), [
    "--version",
  ])
  if (have.includes(version)) {
    logger.info(`Firecracker ${version} is already installed`)
    return
  }
  const arch = "x86_64"
  const data = await download(
    `https://github.com/firecracker-microvm/firecracker/releases/download/${version}/firecracker-${version}-${arch}.tgz`,
    sha256,
  )
  const dir = `release-${version}-${arch}`
  await installFromTarball(data, [
    { from: `${dir}/firecracker-${version}-${arch}`, as: "firecracker" },
    { from: `${dir}/jailer-${version}-${arch}`, as: "jailer" },
  ])
}

async function installCrane() {
  const { version, sha256 } = fcVersions.crane
  const have = await installedVersion(path.join(BIN_DIR, "crane"), ["version"])
  if (have.includes(version.replace(/^v/, ""))) {
    logger.info(`crane ${version} is already installed`)
    return
  }
  const data = await download(
    `https://github.com/google/go-containerregistry/releases/download/${version}/go-containerregistry_Linux_x86_64.tar.gz`,
    sha256,
  )
  await installFromTarball(data, [{ from: "crane", as: "crane" }])
}

/** Install everything a host needs, pinned by firecracker/versions.ts. */
export async function setup(): Promise<void> {
  if (Deno.build.os !== "linux" || Deno.build.arch !== "x86_64") {
    throw new Error("divvun-fc hosts are x86_64 Linux")
  }
  try {
    await Deno.stat("/dev/kvm")
  } catch {
    throw new Error(
      "/dev/kvm is missing: enable virtualisation in the firmware, or nested virtualisation on the hypervisor",
    )
  }

  if (await succeeds("apt-get", ["--version"])) {
    await run("apt-get", ["update"])
    await run("apt-get", ["install", "-y", ...APT_PACKAGES])
  } else {
    logger.warning(
      `No apt-get; install these yourself: ${APT_PACKAGES.join(", ")}`,
    )
  }

  await installFirecracker()
  await installCrane()

  const configDir = path.dirname(DEFAULT_CONFIG_PATH)
  await Deno.mkdir(configDir, { recursive: true, mode: 0o700 })
  try {
    await Deno.stat(DEFAULT_CONFIG_PATH)
  } catch {
    await Deno.copyFile(
      path.fromFileUrl(new URL("../config.example.toml", import.meta.url)),
      DEFAULT_CONFIG_PATH,
    )
    logger.info(
      `Wrote ${DEFAULT_CONFIG_PATH} from the example. Edit it, put the agent token in /etc/divvun-fc/agent-token, then run \`divvun-fc install\`.`,
    )
  }
}
