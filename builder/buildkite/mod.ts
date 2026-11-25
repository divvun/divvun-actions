// deno-lint-ignore-file no-explicit-any
// Buildkite implementation of the builder interface

import * as path from "@std/path"
import { TextLineStream } from "@std/streams"
import { buildkite as getEnv, Env } from "~/util/env.ts"
import logger from "~/util/log.ts"
import type { CiKey } from "~/util/hash.ts"
import { OpenBao, SecretsStore } from "~/util/openbao.ts"
import type { PahkatPublisher, RegistryModule } from "~/util/pahkat.ts"
import { requireTrustedReleaseContext } from "~/util/trusted_context.ts"

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

export async function metadata(name: string) {
  const result = await output("buildkite-agent", ["meta-data", "get", name])
  if (result.status.code !== 0) {
    throw new Error(`Failed to get metadata for ${name}`)
  }
  return result.stdout
}

export const env: Env = getEnv()

let redactedSecrets: SecretsStore | undefined

export async function secrets(
  ...keys: [string, ...string[]]
): Promise<SecretsStore> {
  requireTrustedReleaseContext(env, "access CI secrets")

  if (redactedSecrets != null) {
    return redactedSecrets.only(keys)
  }

  const raw = await (await vault()).secrets()

  for (const value of raw.values()) {
    await redactSecret(value)
  }

  redactedSecrets = raw

  return redactedSecrets.only(keys)
}

const OPENBAO = "https://vault.giellalt.org"

/**
 * The role this build logs in to OpenBao as: `release` for a tag, else its
 * branch's, `main` or kbdgen's and kbdi's `v4`. Each role admits only the
 * builds whose OIDC claims it is bound to (deploy/openbao.sh), so naming the
 * wrong one only gets the login refused.
 */
function vaultRole(): string {
  return env.tag ? "release" : env.branch ?? ""
}

/** A login to OpenBao with this job's Buildkite OIDC token. */
async function logIn(): Promise<OpenBao> {
  const result = await output("buildkite-agent", [
    "oidc",
    "request-token",
    "--audience",
    OPENBAO,
    "--lifetime",
    "60",
  ])
  if (result.status.code !== 0) {
    throw new Error(`Failed to get a Buildkite OIDC token: ${result.stderr}`)
  }
  return await OpenBao.fromJwt(
    OPENBAO,
    "buildkite",
    vaultRole(),
    result.stdout.trim(),
  )
}

/** How long before its token expires a login is replaced. */
const RELOGIN_MARGIN_MS = 5 * 60_000

let vaultLogin: Promise<OpenBao> | undefined

/** The process's OpenBao login, replaced as its token nears expiry. */
function vault(): Promise<OpenBao> {
  vaultLogin =
    vaultLogin?.then((login) =>
      login.expiresAt - Date.now() > RELOGIN_MARGIN_MS ? login : logIn()
    ) ?? logIn()
  return vaultLogin
}

const redactedCiKeys = new Map<string, CiKey>()

/**
 * A CI key of the Pahkat server: by default the Pahkat module's, which
 * signs every release's BLAKE3SUMS, or a registry module's own, which only
 * that module's key list names. Its secret half and its password are
 * separate entries, ci/<module>-ci-key and ci/<module>-ci-key-password, so
 * a leak of one is not enough to sign.
 */
export async function ciKey(
  module: "pahkat" | RegistryModule = "pahkat",
): Promise<CiKey> {
  requireTrustedReleaseContext(env, "sign with the CI key")

  const cached = redactedCiKeys.get(module)
  if (cached != null) {
    return cached
  }

  const client = await vault()
  const { secretKey } = await client.entry(`${module}-ci-key`)
  const { password } = await client.entry(`${module}-ci-key-password`)
  if (!secretKey || !password) {
    throw new Error(`OpenBao's entries for the ${module} CI key are incomplete`)
  }

  // Line by line, as the redactor takes one value at a time; the key file's
  // fixed first line is not secret, and redacting it would mask it everywhere.
  for (const line of secretKey.split("\n")) {
    if (line.trim() !== "" && !line.startsWith("untrusted comment:")) {
      await redactSecret(line.trim())
    }
  }
  await redactSecret(password)

  const key = { secretKey, password }
  redactedCiKeys.set(module, key)
  return key
}

/**
 * A publisher token for `publisher`: an identity token OpenBao signs for
 * its role, `pahkat-<repository>` for a repository of the Pahkat module and
 * `pahkat-<module>-<namespace>` for a registry's namespace, addressed to
 * pahkat-3.giellalt.org and valid for minutes. The server accepts each one
 * once, so every `pahkat upload` run needs a fresh one.
 */
export async function pahkatUploadToken(
  publisher: PahkatPublisher,
): Promise<string> {
  requireTrustedReleaseContext(env, "get a Pahkat publisher token")

  const role = "repository" in publisher
    ? `pahkat-${publisher.repository}`
    : `pahkat-${publisher.module}-${publisher.namespace}`
  const token = await (await vault()).identityToken(role)
  await redactSecret(token)
  return token
}

export async function group(name: string, callback: () => Promise<void>) {
  // deno-lint-ignore no-console
  console.log(`--- ${name}`)
  try {
    await callback()
  } catch (error) {
    // deno-lint-ignore no-console
    console.log(`^^^ +++`)
    logger.error(error)
    throw error
  }
}

export async function uploadArtifacts(
  filePath: string,
  { cwd, preserveAbsolutePath }: {
    cwd?: string
    preserveAbsolutePath?: boolean
  } = {},
) {
  // buildkite stores each artifact under its path relative to the upload cwd, so
  // an absolute path lands under the whole /opt/.../builds/... prefix and later
  // relative download globs can't match it. By default, upload an absolute path
  // under its basename (run buildkite-agent from the file's own directory) so it
  // lands at the artifact root. Pass preserveAbsolutePath to keep the old
  // full-path behaviour.
  if (path.isAbsolute(filePath) && !preserveAbsolutePath) {
    await agentArtifactUpload(path.basename(filePath), path.dirname(filePath))
    return
  }
  await agentArtifactUpload(filePath, cwd)
}

/**
 * `buildkite-agent artifact upload`, with its log (stderr) streamed through
 * line by line so its timings read `upload=3.43s` rather than Go's
 * full-precision `upload=3.428451129s`.
 */
async function agentArtifactUpload(filePath: string, cwd?: string) {
  const args = ["artifact", "upload", filePath]
  const proc = new Deno.Command("buildkite-agent", {
    args,
    cwd,
    stderr: "piped",
  }).spawn()
  const lines = proc.stderr
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream())
  for await (const line of lines) {
    const tidy = line.replace(
      /(\d+\.\d+)(ms|s)\b/g,
      (_, n: string, unit: string) => Number(n).toFixed(2) + unit,
    )
    await Deno.stderr.write(encoder.encode(tidy + "\n"))
  }
  const status = await proc.status
  if (status.code !== 0) {
    throw new Error(
      `Process 'buildkite-agent ${
        JSON.stringify(args)
      }' exited with code ${status.code}`,
    )
  }
}

export async function downloadArtifacts(path: string, outputDir: string) {
  await exec("buildkite-agent", ["artifact", "download", path, outputDir])
}
