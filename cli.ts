// deno-lint-ignore-file no-explicit-any no-console
import { parseArgs, ParseOptions } from "@std/cli/parse-args"
import * as yaml from "@std/yaml"
import * as builder from "~/builder.ts"
import { BuildkitePipeline } from "~/builder/pipeline.ts"
import {
  pipelineDivvunKeyboard,
  runDivvunKeyboard,
} from "~/pipelines/keyboard/divvun-keyboard.ts"

enum Command {
  Run = "run",
  Ci = "ci",
}

type OptionConfig = {
  long?: string
  short?: string
  help?: string
  aliases?: string[]
}

type CommandConfig = {
  options: CommandOption
}

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
  const { command, args } = parseCommand(input)
  console.log(command, args)

  switch (command) {
    case Command.Run:
      await runPipeline(args)
      break
    case Command.Ci:
      await runCi(args)
      break
  }
}

async function runPipeline(args) {
  const pipeline = args._[0]

  switch (pipeline) {
    case "divvunspell":
      // await build()
      break
    case "divvun-keyboard-ios": {
      const kbdgenBundlePath = builder.env.repoName === "divvun-dev-keyboard"
        ? "divvun-dev.kbdgen"
        : "divvun.kbdgen"
      await runDivvunKeyboard(kbdgenBundlePath)
      break
    }
    default:
      throw new Error(`Unknown repo: ${builder.env.repoName}`)
  }
}

async function runCi(args) {
  console.log("Running CI")

  let pipeline: BuildkitePipeline
  switch (builder.env.repoName) {
    case "divvunspell":
      // await build()
      return
      break
    case "divvun-keyboard":
    case "divvun-dev-keyboard": {
      pipeline = pipelineDivvunKeyboard()
      break
    }
    default:
      throw new Error(`Unknown repo: ${builder.env.repoName}`)
  }

  const input = yaml.stringify(pipeline)
  const pipelinePath = await Deno.makeTempFile({ suffix: ".yml" })
  
  try {
    Deno.writeTextFileSync(pipelinePath, input)
    await builder.exec("buildkite-agent", ["pipeline", "upload", pipelinePath])
  } finally {
    await Deno.remove(pipelinePath)
  }
}
