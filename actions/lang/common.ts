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

export async function runLangTests(opts: {
  metadataKey: string
  label: string
}) {
  const { metadataKey, label } = opts

  logger.info(`Downloading ${label} build artifacts for testing`)

  // Download the build directory artifacts from the build step
  await builder.downloadArtifacts("build/**/*", ".")
  await builder.downloadArtifacts("build/*", ".")

  await setupGiellaCoreDependencies()

  // Re-run autogen.sh and configure on this agent to regenerate Makefiles with
  // correct absolute paths. The compiled artifacts are already present so make
  // will not recompile anything — it will only run the test suite.
  logger.info("Running autogen.sh")
  const autogenProc = new Deno.Command("bash", {
    args: ["-c", "./autogen.sh"],
    cwd: Deno.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const autogenStatus = await autogenProc.status
  if (autogenStatus.code !== 0) {
    throw new Error(`autogen.sh failed with exit code ${autogenStatus.code}`)
  }

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
