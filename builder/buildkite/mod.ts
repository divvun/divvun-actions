// deno-lint-ignore-file no-explicit-any no-console
// Buildkite implementation of the builder interface

import { buildkite as getEnv, Env } from "~/util/env.ts"
import logger from "~/util/log.ts"
import { OpenBao, SecretsStore } from "~/util/openbao.ts"

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export type CommandOptions = Omit<Deno.CommandOptions, "args"> & {
  input?: string | Uint8Array
}

export async function exec(
  commandLine: string,
  args: string[],
  options?: CommandOptions,
): Promise<void>
export async function exec(
  commandLine: string,
  options?: CommandOptions,
): Promise<void>
export async function exec(
  commandLine: string,
  arg1?: string[] | CommandOptions,
  arg2?: CommandOptions,
): Promise<void> {
  const args = Array.isArray(arg1) ? arg1 : []
  const options = arg2 ?? (Array.isArray(arg1) ? undefined : arg1)

  const proc = new Deno.Command(commandLine, { ...options, args }).spawn()
  const status = await proc.status

  if (status.code !== 0) {
    throw new Error(
      `Process '${commandLine} ${
        JSON.stringify(args)
      }' exited with code ${status.code}`,
    )
  }
}

export async function output(
  commandLine: string,
  args: string[],
  options?: CommandOptions,
): Promise<{ stdout: string; stderr: string; status: Deno.CommandStatus }>
export async function output(
  commandLine: string,
  options?: CommandOptions,
): Promise<{ stdout: string; stderr: string; status: Deno.CommandStatus }>
export async function output(
  commandLine: string,
  arg1?: string[] | CommandOptions,
  arg2?: CommandOptions,
): Promise<{ stdout: string; stderr: string; status: Deno.CommandStatus }> {
  const args = Array.isArray(arg1) ? arg1 : []
  const options = arg2 ?? (Array.isArray(arg1) ? undefined : arg1)

  let input: string | Uint8Array | undefined
  if (options?.input) {
    input = options.input
    delete options.input
  }

  const proc = await new Deno.Command(commandLine, {
    ...options,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
    args,
  }).spawn()
  ;(async () => {
    if (input) {
      const writer = proc.stdin.getWriter()
      if (typeof input === "string") {
        await writer.write(encoder.encode(input))
      } else {
        await writer.write(input)
      }
      await writer.close()
    }
  })()

  const output = await proc.output()

  return {
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
    status: {
      code: output.code,
      success: output.success,
      signal: output.signal,
    },
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
  const result = await output("buildkite-agent", ["redactor", "add"], {
    input: value,
  })
  if (result.status.code !== 0) {
    throw new Error(`Failed to redact secret: ${result.stderr}`)
  }
}

export async function setMetadata(name: string, value: any) {
  await exec("buildkite-agent", ["meta-data", "set", name, value.toString()])
}

async function bkSecret(name: string) {
  const result = await output("buildkite-agent", ["secret", "get", name])
  if (result.status.code !== 0) {
    throw new Error(`Failed to get metadata for ${name}`)
  }
  return result.stdout.trim()
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

// Fire-and-forget token renewal
async function renewTokenInBackground(
  token: string,
  endpoint: string,
): Promise<void> {
  try {
    // Check token TTL
    const lookupResponse = await fetch(
      `${endpoint}/v1/auth/token/lookup-self`,
      {
        method: "GET",
        headers: {
          "X-Vault-Token": token,
        },
      },
    )

    if (!lookupResponse.ok) {
      logger.error("Failed to lookup token TTL")
      return
    }

    const lookupData = await lookupResponse.json()
    const ttlSeconds = lookupData.data.ttl
    const ttlDays = ttlSeconds / (24 * 60 * 60)

    logger.debug(`Token TTL: ${ttlDays.toFixed(1)} days`)

    // If expiring within 7 days, renew it
    if (ttlDays < 7) {
      logger.debug("Token expiring soon, renewing in background...")

      const renewResponse = await fetch(
        `${endpoint}/v1/auth/token/renew-self`,
        {
          method: "POST",
          headers: {
            "X-Vault-Token": token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
      )

      if (renewResponse.ok) {
        const renewData = await renewResponse.json()
        logger.debug(
          `✅ Token renewed. New TTL: ${
            (renewData.auth.lease_duration / 86400).toFixed(1)
          } days`,
        )
      } else {
        console.error("Failed to renew token in background")
      }
    }
  } catch (e) {
    console.error("Background token renewal failed:", e)
  }
}

export async function secrets(): Promise<SecretsStore> {
  if (redactedSecrets != null) {
    return redactedSecrets
  }

  const serviceToken = await bkSecret("divvun_actions_openbao_service_token")
  if (serviceToken == null) {
    throw new Error("No service token found")
  }
  const endpoint = "https://vault.giellalt.org"

  // Fire off renewal check in background - doesn't block
  renewTokenInBackground(serviceToken, endpoint)

  const vault = await OpenBao.fromServiceToken(endpoint, serviceToken)
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
    // console.log(`~~~ ${name}`)
  } catch (error) {
    console.log(`^^^ +++`)
    logger.error(error)
    throw error
  }
}

export async function uploadArtifacts(
  path: string,
  { cwd }: { cwd?: string } = {},
) {
  await exec("buildkite-agent", ["artifact", "upload", path], {
    cwd,
  })
}

export async function downloadArtifacts(path: string, outputDir: string) {
  await exec("buildkite-agent", ["artifact", "download", path, outputDir])
}
