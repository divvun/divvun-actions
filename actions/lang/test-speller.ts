import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { setupGiellaCoreDependencies } from "./common.ts"

export default async function langSpellerTest() {
  logger.info("Downloading speller build artifacts for testing")

  // Download the build directory artifacts from the speller build step
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

  const configureFlags = await builder.metadata("speller-configure-flags")
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

  logger.info("Running speller tests")

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
    logger.error(`Speller tests failed with exit code ${status.code}`)
    Deno.exit(status.code)
  }

  logger.info("Speller tests passed")
}
