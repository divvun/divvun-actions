import * as path from "@std/path"
import { crypto } from "@std/crypto/crypto"
import type { Env } from "./env.ts"
import { makeTempFile } from "./temp.ts"

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function blake3Hash(filePath: string): Promise<string> {
  const file = await Deno.open(filePath, { read: true })
  const hashBuffer = await crypto.subtle.digest(
    "BLAKE3",
    file.readable as unknown as AsyncIterable<BufferSource>,
  )
  return toHex(new Uint8Array(hashBuffer))
}

/**
 * Generate a BLAKE3SUMS file using the b3sum command line tool.
 * Format: `<hash>  <filename>` (two spaces, like sha256sum)
 */
export async function generateBlake3Sums(
  files: string[],
  outputPath: string = "BLAKE3SUMS",
  cwd?: string,
): Promise<void> {
  const cmd = new Deno.Command("b3sum", {
    args: files,
    cwd,
    stdout: "piped",
    stderr: "piped",
  })

  const { code, stdout, stderr } = await cmd.output()

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr)
    throw new Error(`b3sum failed with code ${code}: ${errorText}`)
  }

  await Deno.writeFile(outputPath, stdout)
}

/** The CI key: a minisign secret key and the password that opens it. */
export type CiKey = {
  secretKey: string
  password: string
}

/**
 * What a release's signature vouches for, in its trusted comment. Pahkat
 * reads it (its attestation.comment): `package` is the package's id on the
 * Pahkat server, repository included, such as `main/speller-sme`, and only
 * releases published as Pahkat packages have one.
 */
export type Release = {
  /** The GitHub repository that built it, such as `giellalt/lang-sme`. */
  repo: string
  /** The tag of the GitHub release it is published under. */
  tag: string
  package?: string
  version: string
  /** The git commit it was built from, as 40 lowercase hex digits. */
  commit: string
}

/** The release this build makes, from its repository and commit. */
export function release(
  env: Pick<Env, "repoPath" | "commit">,
  fields: { tag: string; version: string; package?: string },
): Release {
  if (env.commit == null || !/^[0-9a-f]{40}$/.test(env.commit)) {
    throw new Error(
      `The build's commit ${env.commit} is not 40 lowercase hex digits`,
    )
  }
  return { repo: env.repoPath, commit: env.commit, ...fields }
}

/**
 * One line of Styx, every value a quoted string, which Pahkat reads as it
 * reads bare ones. A value with a quote, a backslash or anything but
 * printable ASCII is refused rather than escaped.
 */
export function trustedComment(release: Release): string {
  const fields: [string, string][] = [
    ["repo", release.repo],
    ["tag", release.tag],
  ]
  if (release.package != null) fields.push(["package", release.package])
  fields.push(["version", release.version], ["commit", release.commit])
  return fields.map(([name, value]) => {
    if (value === "" || !/^[\x20-\x7e]*$/.test(value) || /["\\]/.test(value)) {
      throw new Error(
        `The release's ${name} ${JSON.stringify(value)} cannot be signed`,
      )
    }
    return `${name} "${value}"`
  }).join(", ")
}

/**
 * Sign a file using minisign, with a trusted comment.
 * The password is piped to stdin.
 */
export async function minisign(
  filePath: string,
  privateKeyPath: string,
  password: string,
  comment: string,
): Promise<void> {
  const cmd = new Deno.Command("minisign", {
    args: ["-S", "-s", privateKeyPath, "-m", filePath, "-t", comment],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })

  const process = cmd.spawn()

  const writer = process.stdin.getWriter()
  await writer.write(new TextEncoder().encode(password + "\n"))
  await writer.close()

  const { code, stderr } = await process.output()

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr)
    throw new Error(`minisign failed with code ${code}: ${errorText}`)
  }
}

/**
 * Write BLAKE3SUMS for a release's files and sign it with the CI key, its
 * trusted comment naming the release. The names are bare file names, which
 * Pahkat and drb-kicker match against asset names: with `directory` they
 * are relative to it and both outputs land there, otherwise relative to the
 * working directory.
 */
export async function createSignedChecksums(
  files: string[],
  key: CiKey,
  release: Release,
  directory?: string,
): Promise<{ checksumFile: string; signatureFile: string }> {
  for (const file of files) {
    if (file === "" || /[\/\\\s]/.test(file)) {
      throw new Error(
        `BLAKE3SUMS lists bare file names, not ${JSON.stringify(file)}`,
      )
    }
  }
  if (new Set(files).size !== files.length) {
    throw new Error("BLAKE3SUMS lists each file once")
  }
  const comment = trustedComment(release)

  const checksumFile = path.join(directory ?? ".", "BLAKE3SUMS")
  const signatureFile = `${checksumFile}.minisig`

  await generateBlake3Sums(files, checksumFile, directory)

  using keyFile = await makeTempFile({ suffix: ".key" })
  await Deno.writeTextFile(keyFile.path, key.secretKey)

  await minisign(checksumFile, keyFile.path, key.password, comment)

  return { checksumFile, signatureFile }
}

/**
 * Check a release fetched from the server before anything in it runs: the
 * signature over its BLAKE3SUMS verifies against `key`, its trusted comment
 * names `name` at `version`, and `file`, saved at `saved`, has the BLAKE3
 * hash BLAKE3SUMS lists for it.
 */
export async function checkRelease(
  { sums, signature, saved, file, name, version, key }: {
    sums: string
    signature: string
    saved: string
    file: string
    name: string
    version: string
    key: string
  },
): Promise<void> {
  const verified = await new Deno.Command("minisign", {
    args: ["-V", "-Q", "-P", key, "-m", sums, "-x", signature],
    stdout: "piped",
    stderr: "piped",
  }).output()
  if (verified.code !== 0) {
    throw new Error(
      `The signature over ${name} ${version}'s BLAKE3SUMS does not verify against the CI key: ${
        new TextDecoder().decode(verified.stderr).trim()
      }`,
    )
  }
  const comment = new Map(
    new TextDecoder().decode(verified.stdout).trim().split(", ").map(
      (field) => {
        const space = field.indexOf(" ")
        return [field.slice(0, space), field.slice(space + 1)]
      },
    ),
  )
  if (comment.get("package") !== name || comment.get("version") !== version) {
    throw new Error(
      `${name} ${version}'s BLAKE3SUMS is signed for ${
        comment.get("package")
      } ${comment.get("version")}`,
    )
  }
  const listed = (await Deno.readTextFile(sums)).split("\n")
    .map((line) => /^([0-9a-f]{64}) {2}(.+)$/.exec(line))
    .find((line) => line?.[2] === file)?.[1]
  const hash = await blake3Hash(saved)
  if (listed == null || hash !== listed) {
    throw new Error(
      `${file} of ${name} ${version} is not the file its BLAKE3SUMS lists`,
    )
  }
}
