import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

export default async function langGrammarTest() {
  logger.info("Downloading grammar checker build artifacts for testing")

  await builder.downloadArtifacts("build/**/*", ".")
  await builder.downloadArtifacts("build/*", ".")
  await builder.downloadArtifacts("build-aux/*", ".")
  await builder.downloadArtifacts("aclocal.m4", ".")

  // aclocal.m4 is downloaded with the current timestamp, making it appear newer
  // than the committed 'configure' (which has the git checkout timestamp). This
  // causes make to trigger an autoconf → automake → config.status cascade on the
  // test agent. Matching aclocal.m4's mtime to configure prevents this.
  await new Deno.Command("bash", {
    args: ["-c", "touch -r configure aclocal.m4"],
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
