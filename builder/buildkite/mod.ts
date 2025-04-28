// deno-lint-ignore-file no-explicit-any no-console
// Buildkite implementation of the builder interface

import type { ExecOptions } from "~/builder/types.ts"
import { Env, buildkite as getEnv } from "~/util/env.ts"
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
    throw new Error(`Process '${commandLine} ${JSON.stringify(args)}' exited with code ${status.code}`)
  }

  return status.code
}

export async function output(
  commandLine: string,
  args?: string[],
  options?: ExecOptions,
): Promise<{ stdout: string; stderr: string; status: any }> {
  let stdout = new Uint8Array()
  let stderr = new Uint8Array()

  const proc = await spawn(commandLine, args, {
    ...options,
    listeners: {
      ...options?.listeners,
      stdout: (chunk) => {
        stdout = new Uint8Array([...stdout, ...chunk])
      },
      stderr: (chunk) => {
        stderr = new Uint8Array([...stderr, ...chunk])
      },
    },
  })

  const status = await proc.status
  const decoder = new TextDecoder()

  return {
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
    status,
  }
}

export function addPath(path: string) {
  const sep = Deno.build.os === "windows" ? ";" : ":"
  const p = Deno.env.get("PATH")
  Deno.env.set(
    "PATH",
    `${path}${sep}${p}`,
  )
}

export async function redactSecret(value: string) {
  await exec("buildkite-agent", ["redactor", "add"], { input: value })
}

export async function setMetadata(name: string, value: any) {
  await exec("buildkite-agent", ["meta-data", "set", name, value.toString()])
}

export async function metadata(name: string) {
  const result = await output("buildkite-agent", ["meta-data", "get", name])
  if (result.status.code !== 0) {
    throw new Error(`Failed to get metadata for ${name}`)
  }
  return result.stdout
}

export const env: Env = getEnv()

let redactedSecrets: SecretsStore | undefined

export async function secrets(): Promise<SecretsStore> {
  if (redactedSecrets != null) {
    return redactedSecrets
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

export async function group(name: string, callback: () => Promise<void>) {
  console.log(`--- ${name}`)
  try {
    await callback()
    console.log(`~~~ ${name}`)
  } catch (error) {
    console.log(`^^^ +++`)
    logger.error(error)
  }
}
