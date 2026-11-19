import { or } from "@optique/core/constructs"
import { message, text } from "@optique/core/message"
import type { Parser } from "@optique/core/parser"
import { fail } from "@optique/core/primitives"
import { run } from "@optique/run"

export type Command = () => Promise<void>
export type CommandParser = Parser<"sync", Command, unknown>

/**
 * The commands that run anywhere, in a Buildkite job or not. Nothing here
 * may import `~/builder.ts`, directly or not: it refuses to load outside a
 * Buildkite job.
 */
export const localCommands: CommandParser[] = []

/** The commands cli.ts adds, which only run in a Buildkite job. */
export const BUILDKITE_COMMANDS = ["run", "ci", "sign"] as const
export type BuildkiteCommand = typeof BUILDKITE_COMMANDS[number]

export const RUN_OPTIONS = {
  programName: "divvun-actions",
  help: { option: { names: ["--help", "-h"] } },
  aboveError: "none",
  showUsage: false,
  commandList: "top-level",
} as const

function isBuildkiteCommand(token: string): token is BuildkiteCommand {
  return (BUILDKITE_COMMANDS as readonly string[]).includes(token)
}

/** The command line outside a Buildkite job: only `localCommands`. */
export default async function runCli(input: string[]) {
  const parser = or(
    ...localCommands,
    // Keeps or() valid while no command runs locally.
    fail<Command>(),
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
