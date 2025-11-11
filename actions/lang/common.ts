import * as path from "@std/path"
import * as fs from "@std/fs"
import logger from "~/util/log.ts"

export async function setupGiellaCoreDependencies(): Promise<void> {
  // Check ../giella-core and ../shared-mul
  const giellaCorePath = path.join(Deno.cwd(), "..", "giella-core")
  if (await fs.exists(giellaCorePath)) {
    logger.info("Updating giella-core...")
    // git pull
    const proc = new Deno.Command("git", {
      args: ["pull"],
      cwd: giellaCorePath,
    }).spawn()
    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to update giella-core: ${status.code}`)
    }

    logger.info("Building giella-core...")
    const proc2 = new Deno.Command("make", { cwd: giellaCorePath }).spawn()
    const status2 = await proc2.status
    if (status2.code !== 0) {
      throw new Error(`Failed to build giella-core: ${status2.code}`)
    }
  }

  const sharedMulPath = path.join(Deno.cwd(), "..", "shared-mul")
  if (await fs.exists(sharedMulPath)) {
    logger.info("Updating shared-mul...")
    // git pull
    const proc = new Deno.Command("git", {
      args: ["pull"],
      cwd: sharedMulPath,
    }).spawn()
    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to update shared-mul: ${status.code}`)
    }
  }
}
