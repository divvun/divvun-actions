import logger from "~/util/log.ts"
import runCli from "./cli.ts"
import { ExpectedError } from "./util/error.ts"
import { SOFT_FAIL_EXIT_STATUS, SoftFailure } from "./util/soft_failure.ts"

function prettyPlatform() {
  switch (Deno.build.os) {
    case "darwin":
      return "macos"
    case "windows":
      return "windows"
    case "linux":
      return "linux"
    default:
      return `unsupported: ${Deno.build.os}`
  }
}

logger.debug(`Loading Divvun Actions [Platform: ${prettyPlatform()}]`)

runCli(Deno.args)
  .then(() => {
    logger.info("Finished successfully")
    Deno.exit(0)
  })
  .catch((e) => {
    if (e instanceof SoftFailure) {
      logger.error(e.message)
      if (e.cause) logger.error(e.cause)
      Deno.exit(SOFT_FAIL_EXIT_STATUS)
    }
    logger.error("Build failed with error:")
    if (e instanceof ExpectedError) {
      logger.error(e.message)
      if (e.cause) logger.error(e.cause)
    } else {
      logger.error(e)
    }

    Deno.exit(1)
  })
