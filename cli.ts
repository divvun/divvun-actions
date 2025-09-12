// deno-lint-ignore-file no-explicit-any no-console
import { parseArgs, ParseOptions } from "@std/cli/parse-args"
import * as yaml from "@std/yaml"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline } from "~/builder/pipeline.ts"
import {
  pipelineDesktopKeyboard,
  pipelineDivvunKeyboard,
  runDesktopKeyboardDeploy,
  runDesktopKeyboardMacOS,
  runDesktopKeyboardWindows,
  runDivvunKeyboardAndroid,
  runDivvunKeyboardIOS,
} from "~/pipelines/keyboard/divvun-keyboard.ts"
import logger from "~/util/log.ts"
import { runKbdgenDeploy } from "./actions/kbdgen/deploy.ts"
import {
  pipelineDivvunRuntime,
  runDivvunRuntimePublish,
} from "./pipelines/divvun-runtime.ts"
import { pipelineDivvunspell } from "./pipelines/divvunspell/mod.ts"
import { pipelineKbdgen } from "./pipelines/kbdgen/mod.ts"
import {
  pipelineLang,
  runLang,
  runLangBundle,
  runLangDeploy,
} from "./pipelines/lang/mod.ts"
import pipelineLibpahkat, { runLibpahkatAndroid, runLibpahkatIos, runLibpahkatPublish } from "./pipelines/pahkat/libpahkat.ts"
import sign from "./services/windows-codesign.ts"
import { makeTempFile } from "./util/temp.ts"

enum Command {
  Run = "run",
  Ci = "ci",
  Sign = "sign",
}

// type OptionConfig = {
//   long?: string
//   short?: string
//   help?: string
//   aliases?: string[]
// }

// type CommandConfig = {
//   options: CommandOption
// }

const commands: Record<Command, { options: ParseOptions; help: string }> = {
  [Command.Run]: {
    options: {
      boolean: ["help"],
      alias: {
        help: "h",
      },
    },
    help: "Run a specific pipeline",
  },
  [Command.Ci]: {
    options: {
      boolean: ["help"],
      alias: {
        help: "h",
      },
    },
    help: "Automatically determine pipelines in CI",
  },
  [Command.Sign]: {
    options: {
      boolean: ["help"],
      alias: {
        help: "h",
      },
    },
    help: "Sign a file",
  },
}

function printHelp(command?: Command) {
  if (!command) {
    console.log(`Usage: <command> [options]\n`)
    console.log()
    console.log("Commands:")
    for (const [command, commandOptions] of Object.entries(commands)) {
      console.log(`  ${command}\t${commandOptions.help}`)
    }
    return
  }

  const commandOptions = commands[command as Command]
  console.log(`Usage: ${Deno.args[0]} ${command} [options]`)
  console.log(commandOptions.help)
}

function parseCommand(input: string[]) {
  const args = parseArgs(input, {
    boolean: ["help"],
    stopEarly: true,
    alias: {
      help: "h",
    },
  })

  if (args.help) {
    printHelp(args._[0] as Command)
    Deno.exit(0)
  }

  const command = args._[0] as Command
  const commandOptions = commands[command]?.options
  if (!commandOptions) {
    console.error(`Unknown command: ${command}`)
    printHelp()
    Deno.exit(1)
  }

  const commandArgs = parseArgs(
    args._.slice(1).map((x) => x.toString()),
    commandOptions,
  )
  if (commandArgs.help) {
    printHelp(command)
    Deno.exit(0)
  }

  return { command, args: commandArgs }
}

export default async function runCli(input: string[]) {
  const logLevel = Deno.env.get("LOG_LEVEL")
  if (logLevel) {
    logger.setLogLevel(logLevel)
  }

  const { command, args } = parseCommand(input)

  switch (command) {
    case Command.Run:
      await runPipeline(args)
      break
    case Command.Ci:
      await runCi(args)
      break
    case Command.Sign:
      await runSign(args)
      break
  }
}

async function runSign(args) {
  const inputFile = args._[0]
  await sign(inputFile)
}

function kbdgenBundlePathMobile(): string {
  return builder.env.repoName === "divvun-dev-keyboard"
    ? "divvun-dev.kbdgen"
    : "divvun.kbdgen"
}

async function runPipeline(args) {
  const pipeline = args._[0]

  switch (pipeline) {
    case "divvunspell":
      // await build()
      break
    case "divvun-keyboard-ios": {
      await runDivvunKeyboardIOS(kbdgenBundlePathMobile())
      break
    }
    case "divvun-keyboard-android": {
      await runDivvunKeyboardAndroid(kbdgenBundlePathMobile())
      break
    }
    case "divvun-keyboard-windows": {
      const kbdgenBundlePath = builder.env.repoName.split("-")[1] + ".kbdgen"
      await runDesktopKeyboardWindows(kbdgenBundlePath)
      break
    }
    case "divvun-keyboard-macos": {
      const kbdgenBundlePath = builder.env.repoName.split("-")[1] + ".kbdgen"
      await runDesktopKeyboardMacOS(kbdgenBundlePath)
      break
    }
    case "lang": {
      await runLang()
      break
    }
    case "lang-bundle": {
      await runLangBundle({ target: args._[1] })
      break
    }
    case "lang-deploy": {
      await runLangDeploy()
      break
    }
    case "kbdgen-deploy": {
      await runKbdgenDeploy()
      break
    }
    case "divvun-keyboard-deploy-windows": {
      await runDesktopKeyboardDeploy(KeyboardType.Windows)
      break
    }
    case "divvun-keyboard-deploy-macos": {
      await runDesktopKeyboardDeploy(KeyboardType.MacOS)
      break
    }
    case "divvun-runtime-publish": {
      await runDivvunRuntimePublish()
      break
    }
    case "libpahkat-android": {
      await runLibpahkatAndroid()
      break
    }
    case "libpahkat-ios": {
      await runLibpahkatIos()
      break
    }
    case "libpahkat-publish": {
      await runLibpahkatPublish()
      break
    }
    case "debug": {
      console.log("Environment:")
      console.log(JSON.stringify(builder.env, null, 2))
      break
    }
    default: {
      throw new Error(`Unknown repo: ${builder.env.repoName}`)
    }
  }
}

async function runCi(args) {
  console.log("Running CI")

  let pipeline: BuildkitePipeline
  switch (builder.env.repoName) {
    case "divvunspell":
      pipeline = pipelineDivvunspell()
      break
    case "divvun-keyboard":
    case "divvun-dev-keyboard": {
      pipeline = pipelineDivvunKeyboard()
      break
    }
    case "kbdgen": {
      pipeline = pipelineKbdgen()
      break
    }
    case "divvun-runtime": {
      pipeline = await pipelineDivvunRuntime()
      break
    }
    case "pahkat": {
      if (builder.env.pipelineSlug === "libpahkat") {
        pipeline = await pipelineLibpahkat()
      } else {
        throw new Error(`Unknown pipeline slug: ${builder.env.pipelineSlug}`)
      }
      break
    }
    default: {
      if (builder.env.repoName.startsWith("keyboard-")) {
        pipeline = pipelineDesktopKeyboard()
      } else if (builder.env.repoName.startsWith("lang-")) {
        pipeline = pipelineLang()
      } else {
        throw new Error(`Unknown repo: ${builder.env.repoName}`)
      }
    }
  }

  const input = yaml.stringify(pipeline)
  using pipelinePath = await makeTempFile({ suffix: ".yml" })

  Deno.writeTextFileSync(pipelinePath.path, input)
  await builder.exec("buildkite-agent", [
    "pipeline",
    "upload",
    pipelinePath.path,
  ])
}
