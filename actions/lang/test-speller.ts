import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

export default async function langSpellerTest() {
  logger.info("Downloading speller build artifacts for testing")

  // Download the build directory artifacts from the speller build step
  await builder.downloadArtifacts("build/**/*", ".")

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
