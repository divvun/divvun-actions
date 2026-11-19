import { object, or } from "@optique/core/constructs"
import { message, text } from "@optique/core/message"
import { map, optional, withDefault } from "@optique/core/modifiers"
import type { Parser } from "@optique/core/parser"
import { argument, command, option } from "@optique/core/primitives"
import { string, type ValueParser } from "@optique/core/valueparser"
import { run } from "@optique/run"
import {
  API_TOKEN_FILE,
  API_TOKEN_VARIABLE,
  runTrigger,
} from "~/services/trigger-builds/mod.ts"

export type Command = () => Promise<void>
export type CommandParser = Parser<"sync", Command, unknown>

const regex: ValueParser<"sync", RegExp> = {
  mode: "sync",
  metavar: "REGEX",
  placeholder: /(?:)/,
  parse(input) {
    try {
      return { success: true, value: new RegExp(input) }
    } catch (e) {
      return {
        success: false,
        error: message`${input} is not a regular expression: ${
          text((e as Error).message)
        }`,
      }
    }
  },
  format: (value) => value.source,
}

/**
 * The commands that run anywhere, in a Buildkite job or not. Nothing here
 * may import `~/builder.ts`, directly or not: it refuses to load outside a
 * Buildkite job.
 */
export const localCommands: [CommandParser, ...CommandParser[]] = [
  command(
    "trigger",
    map(
      object({
        pattern: argument(regex, {
          description: message`Matched against each pipeline's slug`,
        }),
        branch: optional(
          option("--branch", "-b", string({ metavar: "BRANCH" }), {
            description:
              message`The branch every pipeline builds, instead of its default`,
          }),
        ),
        message: withDefault(
          option("--message", "-m", string({ metavar: "MESSAGE" }), {
            description: message`The builds' message`,
          }),
          "Triggered with divvun-actions trigger",
        ),
        org: withDefault(
          option("--org", string({ metavar: "ORG" }), {
            description: message`The Buildkite organization`,
          }),
          "divvun",
        ),
        dryRun: option("--dry-run", {
          description: message`List the builds, and trigger none`,
        }),
        yes: option("--yes", "-y", {
          description: message`Trigger without asking first`,
        }),
      }),
      (options) => async () => {
        await runTrigger(options)
      },
    ),
    {
      brief: message`Build each Buildkite pipeline whose slug matches a regex`,
      footer: message`Reads a Buildkite API access token from ${
        text(API_TOKEN_VARIABLE)
      }, or else from ${text(API_TOKEN_FILE)}.`,
    },
  ),
]

/** The commands cli.ts adds, which only run in a Buildkite job. */
export const BUILDKITE_COMMANDS = ["run", "ci", "sign"] as const
export type BuildkiteCommand = typeof BUILDKITE_COMMANDS[number]

export const RUN_OPTIONS = {
  programName: "divvun-actions",
  help: { option: { names: ["--help", "-h"] } },
  aboveError: "none",
  showUsage: false,
  showDefault: true,
  commandList: "top-level",
} as const

function isBuildkiteCommand(token: string): token is BuildkiteCommand {
  return (BUILDKITE_COMMANDS as readonly string[]).includes(token)
}

/** The command line outside a Buildkite job: only `localCommands`. */
export default async function runCli(input: string[]) {
  const parser = or(
    ...localCommands,
    {
      errors: {
        noMatch: message`No command given.`,
        unexpectedInput: (token) =>
          isBuildkiteCommand(token)
            ? message`${text(token)} only runs in a Buildkite job.`
            : message`Unexpected option or subcommand: ${token}.`,
      },
    },
  )
  const execute = run(parser, {
    ...RUN_OPTIONS,
    args: input,
    footer: message`${
      text(new Intl.ListFormat("en-GB").format(BUILDKITE_COMMANDS))
    } only run in a Buildkite job.`,
  })
  await execute()
}
