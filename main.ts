import * as builder from "~/builder.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import runCli from "./cli.ts"
import { ExpectedError } from "./util/error.ts"

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

logger.debug(
  `Loading Divvun Actions [Mode: ${builder.mode}] [Env: ${target.env}] [Platform: ${prettyPlatform()}]`,
)

async function main() {
  const envFilePath = Deno.env.get("ENV_FILE")
  if (envFilePath != null) {
    const envFile = await Deno.readTextFile(envFilePath)
    const env = JSON.parse(envFile)
    for (const [key, value] of Object.entries(env)) {
      Deno.env.set(key, value as string)
    }
  }

  switch (builder.mode) {
    case "local": {
      // await localMain()
      throw new Error("Local mode not implemented")
    }
    case "buildkite": {
      await buildkiteMain()
      return
    }
    default:
      throw new Error(`Unknown mode: ${builder.mode}`)
  }
}

async function buildkiteMain() {
  await runCli(Deno.args)
}

main()
  .then(() => {
    logger.info("Finished successfully")
    Deno.exit(0)
  })
  .catch((e) => {
    logger.error("Build failed with error:")
    if (e instanceof ExpectedError) {
      logger.error(e.message)
    } else {
      logger.error(e)
    }

    Deno.exit(1)
  })
