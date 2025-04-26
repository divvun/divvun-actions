// deno-lint-ignore-file no-explicit-any
import { Command } from "@cliffy/command"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { DivvunActionsConfig } from "~/util/config.ts"

// import { version } from "./package.json" with { "type": "json" };

import type { CommandStep } from "~/builder/pipeline.ts"
import { runLocalPipeline } from "~/pipelines/mod.ts"
import * as target from "~/target.ts"
import Docker from "~/util/docker.ts"
import logger from "~/util/log.ts"
import Tart from "~/util/tart.ts"
import divvunspellLinux from "./pipelines/divvunspell/linux.ts"
import divvunspellMacos from "./pipelines/divvunspell/macos.ts"
import divvunspellWindows from "./pipelines/divvunspell/windows.ts"

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

const program = new Command()
const local = new Command()

program
  .name("divvun-actions")
  .description("CLI for Divvun Actions")
  .option("--log-level <level>", "Log level", "info")
  .action((options: any) => {
    logger.setLogLevel(options.logLevel)
  })
  .command("local", local)

// const local = program
// .command("local")
// .description("Run local tasks")
// .action(async () => {
//   await localMain()
// })

const pipeline = local
  .command("pipeline")
  .description("Run pipeline tasks")
  .arguments("<file>")
  .action(async (options: any, ...args: any[]) => {
    // Default agent should be the host agent.
    const config: DivvunActionsConfig = toml.parse(
      await Deno.readTextFile(
        "DivvunActions.toml",
      ),
    )
    await runLocalPipeline(config, args[0])
  })

const step = new Command()
local.command("step", step)

step.command("command")
  .arguments("<command>")
  .action(async (options: any, ...args: any[]) => {
    // Uh this makes no sense. We should just run whatever this is going to be directly from the pipeline runner above.
    console.log("command", options, args)
  })

const divvunspell = program
  .command("divvunspell")
  .description("Run divvunspell pipeline tasks")
  .option("--platform <platform>", "Target platform (macos, linux)")

divvunspell
  .command("build")
  .description("Build divvunspell")
  .option("--divvun-key <key>", "Divvun key for authentication")
  .option("--skip-setup", "Skip setup step")
  .option("--ignore-dependencies", "Ignore step dependencies", false)
  .action(
    async (
      options: { divvunKey: any; skipSetup: any; ignoreDependencies: any },
    ) => {
      const { divvunKey, skipSetup, ignoreDependencies } = options
      const platform = divvunspell.opts().platform.toLowerCase()
      const props = { divvunKey, skipSetup, ignoreDependencies }
      const config: DivvunActionsConfig = toml.parse(
        await Deno.readTextFile(
          "DivvunActions.toml",
        ),
      )

      await enterEnvironment(
        config.targets?.macos?.remote,
        platform,
        async () => {
          switch (platform) {
            case "macos":
              await divvunspellMacos("build", props, {
                ignoreDependencies,
              })
              break
            case "linux":
              await divvunspellLinux("tarball", props, {
                // ignoreDependencies,
              })
              break
            case "windows":
              await divvunspellWindows("build", props, {
                ignoreDependencies,
              })
              break
            default:
              logger.error("Unsupported platform. Use 'macos' or 'linux'")
              Deno.exit(1)
          }
        },
      )
    },
  )

divvunspell
  .command("codesign")
  .description("Run codesign step")
  .option("-k, --divvun-key <key>", "Divvun key for signing")
  .option("--skip-setup", "Skip setup step", false)
  .option("--skip-signing", "Skip signing step", false)
  .option("--ignore-dependencies", "Ignore step dependencies", false)
  .action(
    async (
      options: {
        divvunKey: any
        skipSetup: any
        skipSigning: any
        ignoreDependencies: any
      },
    ) => {
      await divvunspellMacos(
        "codesign",
        {
          divvunKey: options.divvunKey,
          skipSetup: options.skipSetup,
          skipSigning: options.skipSigning,
        },
        {
          ignoreDependencies: options.ignoreDependencies,
        },
      )
    },
  )

divvunspell
  .command("tarball")
  .description("Run tarball step")
  .option("-k, --divvun-key <key>", "Divvun key for signing")
  .option("--skip-setup", "Skip setup step", false)
  .option("--skip-signing", "Skip signing step", false)
  .option("--ignore-dependencies", "Ignore step dependencies", false)
  .action(
    async (
      options: {
        divvunKey: any
        skipSetup: any
        skipSigning: any
        ignoreDependencies: any
      },
    ) => {
      await divvunspellMacos(
        "tarball",
        {
          divvunKey: options.divvunKey,
          skipSetup: options.skipSetup,
          skipSigning: options.skipSigning,
        },
        {
          ignoreDependencies: options.ignoreDependencies,
        },
      )
    },
  )

async function enterEnvironment(
  config: DivvunActionsConfig | undefined,
  platform: string,
  artifactsDir: string,
  callback: () => Promise<void>,
) {
  const workingDir = target.workingDir
  let id: string | undefined = undefined

  switch (platform) {
    case "macos": {
      if (Deno.build.os === "darwin") {
        const isInVirtualMachine = Tart.isInVirtualMachine()

        if (!isInVirtualMachine) {
          await Tart.enterVirtualMachine(
            config?.targets?.macos,
            workingDir,
            artifactsDir,
          )
          return
        }

        id = await Tart.enterWorkspace()
      } else {
        throw new Error(`Unsupported platform: ${platform}`)
      }
      break
    }
    case "linux":
    case "windows": {
      const isInContainer = await Docker.isInContainer()

      if (!isInContainer) {
        logger.info(`Working directory: ${workingDir}`)
        logger.info("Entering Docker container environment...")
        await Docker.enterEnvironment("divvun-actions", workingDir)
        return
      } else {
        id = await Docker.enterWorkspace()
      }
      break
    }
    default:
      logger.error(`Unsupported platform: ${platform}`)
      Deno.exit(1)
  }

  try {
    await callback()
  } catch (e) {
    logger.error(e)
  }

  switch (platform) {
    case "macos": {
      if (id) {
        await Tart.exitWorkspace(id)
      }
      break
    }
    case "linux":
    case "windows": {
      if (id) {
        await Docker.exitWorkspace(id)
      }
      break
    }
  }
}

async function localMain() {
  const realWorkingDir = target.workingDir
  const realCommand = target.command

  if (realWorkingDir == null) {
    logger.error("main.ts cannot be run directly.")
    Deno.exit(1)
  }

  if (realCommand != null) {
    const workspaceDir = await Docker.enterWorkspace()
    console.log(realCommand)

    const command = JSON.parse(realCommand) as CommandStep

    if (command.command == null) {
      logger.error("command is null")
      Deno.exit(1)
    }

    const proc = new Deno.Command("bash", {
      args: [
        "-c",
        Array.isArray(command.command)
          ? command.command.join("; ")
          : command.command,
      ],
      cwd: workspaceDir,
    })
    await proc.spawn().status
    await Docker.exitWorkspace(workspaceDir)
    return
  }
  // if (realCommand != null) {
  //   // Do this
  // }

  await program.parse(Deno.args)
}

// function delay(timeout: number) {
//   return new Promise((resolve) => setTimeout(resolve, timeout))
// }

async function main() {
  // builder.startGroup("hello")
  // const secrets = await builder.secrets()
  // logger.info(secrets)
  // logger.error("oh my")
  // await delay(500)
  // builder.warning("less oh my")
  // logger.info("1")
  // logger.info("2")
  // logger.info("3")
  // await delay(500)
  // logger.info("4")
  // logger.info("5")
  // await delay(1000)
  // logger.info("example ends in 2 seconds")
  // await delay(2000)
  // builder.endGroup()

  // await delay(500)
  // logger.info("Group is now closed!")

  // builder.setMaxLines(-1)

  switch (builder.mode) {
    case "local": {
      await localMain()
      return
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
  console.log(builder.env())
  console.log(Deno.env.toObject())
  logger.info("Buildkite main")
}

main()
  // .then(() => {
  //   console.log("HELP")
  //   Deno.exit(0)
  // })
  .catch((e) => {
    logger.error(e)
    Deno.exit(1)
  })
