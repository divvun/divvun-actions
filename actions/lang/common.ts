import * as path from "@std/path"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
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

export async function downloadAndExtractSpellerSnapshot(): Promise<void> {
  // Download the workspace snapshot produced by the speller-build step and
  // extract it. tar -p restores mtimes, so make sees build artifacts as newer
  // than sources and will not attempt to recompile anything.
  await builder.downloadArtifacts("workspace-speller.tar.gz", ".")
  logger.info("Extracting speller workspace snapshot")
  const extractProc = new Deno.Command("tar", {
    args: ["-xpf", "workspace-speller.tar.gz"],
    cwd: Deno.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const extractStatus = await extractProc.status
  if (extractStatus.code !== 0) {
    throw new Error(
      `tar extraction failed with exit code ${extractStatus.code}`,
    )
  }
  await Deno.remove("workspace-speller.tar.gz")
}

export async function runLangTests(opts: {
  metadataKey: string
  label: string
}) {
  const { metadataKey, label } = opts

  logger.info(`Downloading ${label} workspace snapshot`)
  await downloadAndExtractSpellerSnapshot()

  await setupGiellaCoreDependencies()

  // Re-run configure (not autogen) to regenerate Makefiles with the correct
  // absolute paths for this agent. The compiled artifacts already have their
  // original mtimes from the build machine, so make will not recompile them.
  const configureFlags = await builder.metadata(metadataKey)
  logger.info("Running configure")
  const configureProc = new Deno.Command("bash", {
    args: ["-c", `../configure ${configureFlags}`],
    cwd: path.join(Deno.cwd(), "build"),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const configureStatus = await configureProc.status
  if (configureStatus.code !== 0) {
    throw new Error(`configure failed with exit code ${configureStatus.code}`)
  }

  logger.info(`Running ${label} tests`)

  // Run make check in the build directory
  const proc = new Deno.Command("bash", {
    args: ["-c", "make -j$(nproc) check"],
    cwd: path.join(Deno.cwd(), "build"),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()

  const status = await proc.status

  // Exit with the actual test exit code - soft_fail in pipeline config handles continuation
  if (status.code !== 0) {
    logger.error(`${label} tests failed with exit code ${status.code}`)
    Deno.exit(status.code)
  }

  logger.info(`${label} tests passed`)
}
