import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

export default async function langSpellerTest() {
  logger.info("Downloading speller build artifacts for testing")

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
  //
  // Fix: set all autotools-generated source files to the timestamp of configure.ac
  // (a committed file with T_checkout). Since T_checkout < T_download for all
  // build/ artifacts, the generated source files will always appear older than
  // the build outputs, and no cascade can fire regardless of download ordering.
  //
  // The chains are:  configure.ac / m4/*.m4 → aclocal.m4 → configure → config.status → Makefile
  //                 Makefile.am → Makefile.in → Makefile
  await new Deno.Command("bash", {
    args: [
      "-c",
      "touch -r configure.ac configure aclocal.m4 build/config.status && " +
        "find . -not -path './build/*' -not -path './.git/*' -newer configure.ac -exec touch -r configure.ac {} +",
    ],
    cwd: Deno.cwd(),
  }).spawn().status

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
