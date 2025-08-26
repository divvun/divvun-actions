// deno-lint-ignore-file require-await no-explicit-any
// Local implementation of the builder interface

import type { ExecOptions } from "~/builder/types.ts"
import * as command from "~/util/command.ts"
import { Env, local as getEnv } from "~/util/env.ts"
import logger from "~/util/log.ts"
import { OpenBao, SecretsStore } from "~/util/openbao.ts"

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

export function addPath(path: string) {
  const sep = Deno.build.os === "windows" ? ";" : ":"
  const p = Deno.env.get("PATH")
  Deno.env.set(
    "PATH",
    `${path}${sep}${p}`,
  )
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

export async function setOutput(name: string, value: any) {
  await exec("buildkite-agent", ["meta-data", "set", name, value.toString()])
}

export const env: Env = getEnv()

let redactedSecrets: SecretsStore | undefined

// Fire-and-forget token renewal
async function renewTokenInBackground(
  token: string,
  endpoint: string,
): Promise<void> {
  return Promise.reject("Not implemented")
}

export async function secrets(): Promise<SecretsStore> {
  if (redactedSecrets != null) {
    return redactedSecrets
  }

  // Check if there's a service token to renew
  const serviceToken = Deno.env.get("DIVVUN_ACTIONS_OPENBAO_SERVICE_TOKEN")
  if (serviceToken) {
    // Fire off renewal check in background
    renewTokenInBackground(serviceToken, "https://vault.giellalt.org")
  }

  const vaultRoleId = Deno.env.get("DIVVUN_ACTIONS_VAULT_ROLE_ID")
  const vaultRoleSecret = Deno.env.get("DIVVUN_ACTIONS_VAULT_ROLE_SECRET")

  if (vaultRoleId == null) {
    throw new Error("DIVVUN_ACTIONS_VAULT_ROLE_ID is not defined")
  }

  if (vaultRoleSecret == null) {
    throw new Error("DIVVUN_ACTIONS_VAULT_ROLE_SECRET is not defined")
  }

  const vault = await OpenBao.fromAppRole(
    "https://vault.giellalt.org",
    vaultRoleId,
    vaultRoleSecret,
  )
  const raw = await vault.secrets()

  for (const value of raw.values()) {
    await redactSecret(value)
  }

  redactedSecrets = raw

  return redactedSecrets
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
