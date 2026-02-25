import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

export default async function langGrammarTest() {
  logger.info("Downloading grammar checker build artifacts for testing")

  await builder.downloadArtifacts("build/**/*", ".")
  await builder.downloadArtifacts("build/*", ".")
  await builder.downloadArtifacts("build-aux/*", ".")
  await builder.downloadArtifacts("aclocal.m4", ".")
  await builder.downloadArtifacts("configure", ".")
  await builder.downloadArtifacts("**/Makefile.in", ".")
  await builder.downloadArtifacts("Makefile.in", ".")

  // Artifact downloads give each file the current timestamp, so later-downloaded
  // files appear newer than earlier ones. This causes make to see false staleness
  // and trigger the autotools cascade (autoconf, automake, config.status).
  // Fix: set configure, aclocal.m4, and all Makefile.in files to match
  // build/config.status's timestamp, which is logically the end of the chain
  // (aclocal.m4 → configure → config.status → Makefile).
  await new Deno.Command("bash", {
    args: [
      "-c",
      "touch -r build/config.status configure aclocal.m4 && " +
        "find . -name Makefile.in -not -path './build/*' -exec touch -r build/config.status {} +",
    ],
    cwd: Deno.cwd(),
  }).spawn().status

  logger.info("Running grammar checker tests")

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
    logger.error(`Grammar checker tests failed with exit code ${status.code}`)
    Deno.exit(status.code)
  }

  logger.info("Grammar checker tests passed")
}
