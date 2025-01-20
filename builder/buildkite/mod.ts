// deno-lint-ignore-file require-await no-explicit-any
// Buildkite implementation of the builder interface

import type { Context, ExecOptions, InputOptions } from "~/builder/types.ts"
import * as command from "~/util/command.ts"
import logger from "~/util/log.ts"

// Buildkite-specific implementations

export async function spawn(
  commandLine: string,
  args?: string[],
  options?: ExecOptions,
): Promise<Deno.ChildProcess> {
  const stdio: "inherit" | "piped" | "null" =
    options?.listeners?.stdout || options?.listeners?.stderr
      ? "piped"
      : options?.silent
      ? "null"
      : "inherit"

  const command = new Deno.Command(commandLine, {
    args: args || [],
    cwd: options?.cwd,
    env: options?.env,
    stdin: options?.input ? "piped" : "inherit",
    stdout: stdio,
    stderr: stdio,
  })

  const process = command.spawn()

  if (options?.input != null) {
    const encoder = new TextEncoder()
    const writer = process.stdin.getWriter()
    await writer.write(encoder.encode(options.input))
    await writer.close()
  }

  if (options?.listeners?.stdout && process.stdout) {
    ;(async () => {
      for await (const chunk of process.stdout) {
        options?.listeners?.stdout?.(chunk)
      }
    })()
  }

  if (options?.listeners?.stderr && process.stderr) {
    ;(async () => {
      for await (const chunk of process.stderr) {
        options?.listeners?.stderr?.(chunk)
      }
    })()
  }

  return process
}

export async function exec(
  commandLine: string,
  args?: string[],
  options?: ExecOptions,
): Promise<number> {
  const proc = await spawn(commandLine, args, options)
  const status = await proc.status

  if (status.code !== 0 && !options?.ignoreReturnCode) {
    throw new Error(`Process exited with code ${status.code}`)
  }

  return status.code
}

export async function addPath() {
  throw new Error("Add path is not available in Buildkite")
}

export async function getInput(
  _variable: string,
  _options?: InputOptions,
): Promise<string> {
  // try {
  //   const value = await new Promise<string>((resolve, reject) => {
  //     exec("buildkite-agent", ["meta-data", "get", variable])
  //       .then((code) => {
  //         if (code === 0) {
  //           resolve(process.stdout.toString().trim())
  //         } else {
  //           reject(new Error(`Failed to get meta-data for ${variable}`))
  //         }
  //       })
  //       .catch(reject)
  //   })

  //   if (value && options?.trimWhitespace !== false) {
  //     return value.trim()
  //   }
  //   return value
  // } catch (_) {
  //   if (options?.required) {
  //     throw new Error(`Input required and not supplied: ${variable}`)
  //   }
  //   return ""
  // }
  throw new Error("Input is not available in Buildkite")
}

export async function setOutput(name: string, value: any) {
  await exec("buildkite-agent", ["meta-data", "set", name, value.toString()])
}

export const context: Context = {
  ref: Deno.env.get("BUILDKITE_COMMIT")!,
  workspace: Deno.env.get("BUILDKITE_BUILD_CHECKOUT_PATH")!,
  repo: Deno.env.get("BUILDKITE_REPO")!,
}

export async function secrets(): Promise<Record<string, string>> {
  throw new Error("Secrets are not available in Buildkite")
}

export async function setMaxLines(lines: number) {
  _cmd("config", undefined, { "maxVisibleLines": lines })
}

export async function group(name: string, callback: () => Promise<void>) {
  _cmd("start-group", name)
  try {
    await callback()
    _cmd("end-group", undefined, { close: true })
  } catch (error) {
    logger.error(error)
    _cmd("end-group", undefined, { close: false })
  }
}

const encoder = new TextEncoder()

function _write(value: string) {
  Deno.stdout.writeSync(encoder.encode(value + "\n"))
}

function _cmd(name: command.CommandName, value?: string, data?: any) {
  return _write(command.stringify({ name, data, value }))
}

export async function redactSecret(value: string) {
  _cmd("redact", value)
}
