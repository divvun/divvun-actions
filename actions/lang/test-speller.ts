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

  // Artifact downloads give each file the current timestamp, so later-downloaded
  // files appear newer than earlier ones. This causes make to see:
  //   aclocal.m4 > configure → run autoconf
  //   configure > build/config.status → run config.status --recheck
  // Fix: set configure and aclocal.m4 to match build/config.status, which was
  // generated from configure during the build and is logically the newest in
  // the autotools chain (aclocal.m4 → configure → config.status).
  await new Deno.Command("bash", {
    args: ["-c", "touch -r build/config.status configure aclocal.m4"],
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
