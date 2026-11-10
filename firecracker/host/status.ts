// deno-lint-ignore-file no-console
import { run } from "./cmd.ts"
import type { Config } from "./config.ts"
import { currentVersion, imageDir, kernelDir } from "./images.ts"
import { cachePaths } from "./slot.ts"

async function unitState(slot: string): Promise<string> {
  const out = await run("systemctl", [
    "is-active",
    `divvun-fc@${slot}.service`,
  ], { okCodes: [1, 3, 4] })
  return out.stdout.trim() || "unknown"
}

async function cacheSummary(disk: string): Promise<string> {
  try {
    const out = (await run("dumpe2fs", ["-h", disk])).stdout
    const total = Number(out.match(/^Block count:\s+(\d+)$/m)?.[1])
    const free = Number(out.match(/^Free blocks:\s+(\d+)$/m)?.[1])
    const size = Number(out.match(/^Block size:\s+(\d+)$/m)?.[1])
    if (!total || !size) return "unreadable"
    const gib = (blocks: number) => (blocks * size / 1024 ** 3).toFixed(0)
    return `${gib(total - free)}/${gib(total)} GiB used`
  } catch {
    return "none yet"
  }
}

export async function status(config: Config): Promise<void> {
  const kernel = await currentVersion(kernelDir(config))
  console.log(`kernel  ${kernel?.ref ?? "not converted yet"}`)
  for (const pool of config.pools) {
    const image = await currentVersion(imageDir(config, pool.image))
    console.log(
      `pool    ${pool.name}: ${pool.count} x ${pool.vcpus} vCPU, ${
        pool.memoryMib / 1024
      } GiB, tags ${pool.tags.join(",")}`,
    )
    console.log(
      `        image ${image?.ref ?? `${pool.image}, not converted yet`}`,
    )
  }
  console.log()
  for (const slot of config.slots) {
    const state = await unitState(slot.name)
    const cache = await cacheSummary(cachePaths(config, slot).disk)
    console.log(`${slot.name.padEnd(24)} ${state.padEnd(12)} cache ${cache}`)
  }
}
