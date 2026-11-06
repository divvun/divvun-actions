// Publishing releases to the Pahkat server, and installing from it, with
// the pahkat CLI of divvun/pahkat-next, whose docs/spec/upload.md is the
// upload protocol.

import { exists } from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { ExpectedError } from "~/util/error.ts"
import { ghWithRetry } from "~/util/github.ts"
import { globFiles } from "~/util/glob.ts"
import { checkRelease, createSignedChecksums, release } from "~/util/hash.ts"
import logger from "~/util/log.ts"
import {
  pahkatArtifactName,
  pahkatArtifactPath,
} from "~/util/pahkat_artifacts.ts"
import { makeTempDir } from "~/util/temp.ts"

export const PAHKAT_SERVER = "https://pahkat-3.giellalt.org/"

/** The server's one repository, which every package name starts with. */
export const PAHKAT_REPOSITORY = "main"

/** The CLI's package, which divvun/pahkat-next's main builds publish. */
export const PAHKAT_CLI_PACKAGE = "pahkat"

/**
 * The CI key the server's key list names, which signs every release's
 * BLAKE3SUMS, the CLI's too. A CLI fetched from the server runs only once
 * its release verifies against it.
 */
const PAHKAT_CI_KEY = "RWQkp7YVzweZBSfw15ZgnFk5JC2XL7RpuRMf+Py/i+THc1JMVpUzBR3r"

let fetched: Promise<string> | undefined

/** The pahkat CLI, fetched from the server once per process. */
function pahkatCli(): Promise<string> {
  fetched ??= fetchCli()
  return fetched
}

/**
 * The newest pahkat CLI the server offers for this agent on the dev
 * channel, through its download link (download.latest): the release link it
 * leads to names the release, whose BLAKE3SUMS and signature lie beside it.
 * The CLI runs only when the signature verifies against the CI key, its
 * trusted comment names that release, and the box's hash is the one listed.
 */
async function fetchCli(): Promise<string> {
  const name = `${PAHKAT_REPOSITORY}/${PAHKAT_CLI_PACKAGE}`
  const os = Deno.build.os === "darwin" ? "macos" : Deno.build.os
  const query = new URLSearchParams({
    os,
    arch: Deno.build.arch,
    channel: "dev",
  })
  const latest = new URL(
    `v1/download/${name}/latest?${query}`,
    PAHKAT_SERVER,
  )
  const answer = await fetch(latest, { redirect: "manual" })
  await answer.body?.cancel()
  const location = answer.headers.get("location")
  if (answer.status !== 303 || location == null) {
    throw ExpectedError.create(
      `${PAHKAT_SERVER} offers no ${name} for ${os} on ${Deno.build.arch} (it answered ${answer.status}), so there is no pahkat CLI to run`,
    )
  }
  const link = new URL(location, latest)
  const parts = link.pathname.split("/")
  const file = decodeURIComponent(parts.at(-1)!)
  const version = decodeURIComponent(parts.at(-2)!)

  // The CLI is run until the process exits, so its directory lasts as long.
  const dir = await Deno.makeTempDir({ prefix: "pahkat-cli-" })
  globalThis.addEventListener("unload", () => {
    try {
      Deno.removeSync(dir, { recursive: true })
    } catch {
      // Already gone.
    }
  })
  const save = async (url: URL, as: string) => {
    const response = await fetch(url)
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Could not fetch ${url}: ${response.status}`)
    }
    const target = path.join(dir, as)
    await Deno.writeFile(target, new Uint8Array(await response.arrayBuffer()))
    return target
  }
  const sums = await save(new URL("BLAKE3SUMS", link), "BLAKE3SUMS")
  const signature = await save(
    new URL("BLAKE3SUMS.minisig", link),
    "BLAKE3SUMS.minisig",
  )
  const box = await save(link, "pahkat.pkt.box")

  await checkRelease({
    sums,
    signature,
    saved: box,
    file,
    name,
    version,
    key: PAHKAT_CI_KEY,
  })

  const root = path.join(dir, "root")
  await builder.exec("box", ["extract", "--quiet", "-o", root, box])
  const cli = path.join(root, "bin", os === "windows" ? "pahkat.exe" : "pahkat")
  if (os !== "windows") await Deno.chmod(cli, 0o755)
  const { stdout } = await new Deno.Command(cli, {
    args: ["--version"],
    stdout: "piped",
    stderr: "inherit",
  }).output()
  logger.info(
    `Using ${new TextDecoder().decode(stdout).trim()}, ${name} ${version}`,
  )
  return cli
}

export type ArtifactKind = "box" | "outto-windows" | "outto-macos"
export type Os = "windows" | "macos" | "linux" | "ios" | "android"
export type Arch = "x86_64" | "aarch64" | "i686" | "armv7"

/** A file of a release, and what its pahkat.styx says it is. */
export type Artifact = {
  /** The file, published under its own name. */
  path: string
  kind: ArtifactKind
  /** An installer's outto id, which keys what outto records on the machine. */
  outtoId?: string
  /** The systems a box serves, none for any; an installer serves its own. */
  os?: Os[]
  /** None for any. */
  arch?: Arch[]
  /** The OS's own version, dot-separated numbers, such as 10.0.22000. */
  minOsVersion?: string
}

/** What pahkat.styx says about a release besides its artifacts. */
export type Metadata = {
  /** Language tag to text. */
  names: Record<string, string>
  descriptions?: Record<string, string>
  authors: string[]
  /** An SPDX licence expression. */
  license: string
  licenseUrl?: string
  /** The server derives the release's `lang:` tags from these. */
  languages?: string[]
  /** `class:key`, never `lang:`. */
  tags?: string[]
  /** A full package name to the lowest version that will do, or null. */
  dependencies?: Record<string, string | null>
}

export type PahkatRelease = {
  /** The package's id without its repository, such as `speller-sme`. */
  package: string
  version: string
  /** The tag of the GitHub release this build is published under. */
  tag: string
  metadata: Metadata
  artifacts: Artifact[]
  /**
   * The pahkat CLI to publish with, rather than the server's. pahkat-next
   * publishes its CLI with the one it has just built.
   */
  cli?: string
}

/** A Pahkat version (version.grammar): no `v`, and only these suffixes. */
const VERSION = new RegExp(
  String.raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)` +
    String.raw`(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*)|-dev\.\d{8}T\d{6}Z)?` +
    String.raw`(?:\+build\.(?:0|[1-9]\d*))?$`,
)

/**
 * The version an artifact of the package `id` carries in its name, which
 * the builds write as `<id>_<version>_<platform>…`.
 */
export function versionInName(file: string, id: string): string {
  const name = path.basename(file)
  const version = name.startsWith(`${id}_`)
    ? name.slice(id.length + 1).split("_", 1)[0]
    : ""
  if (!VERSION.test(version)) {
    throw ExpectedError.create(
      `${name} is not named ${id}_<version>_… with a Pahkat version`,
    )
  }
  return version
}

/** The one version the artifacts of a release of `id` all carry. */
export function oneVersion(artifacts: Artifact[], id: string): string {
  const versions = [...byVersion(artifacts, id).keys()]
  if (versions.length !== 1) {
    throw ExpectedError.create(
      `The artifacts of one release of ${id} carry ${
        versions.length === 0 ? "no version" : versions.join(", ")
      }: ${artifacts.map((a) => path.basename(a.path)).join(", ")}`,
    )
  }
  return versions[0]
}

/** The artifacts of the package `id` by the version their names carry. */
export function byVersion(
  artifacts: Artifact[],
  id: string,
): Map<string, Artifact[]> {
  const versions = new Map<string, Artifact[]>()
  for (const artifact of artifacts) {
    const version = versionInName(artifact.path, id)
    versions.set(version, [...versions.get(version) ?? [], artifact])
  }
  return versions
}

/** Where an artifact is among the build's Pahkat artifacts. */
export type ArtifactSource = Omit<Artifact, "path"> & {
  /**
   * A pattern for exactly one file of the package's Pahkat artifacts
   * (util/pahkat_artifacts.ts), by its own name, such as
   * `*_noarch-mobile.pkt.box`.
   */
  name: string
  /** Leave the artifact out when the build did not make it, not fail. */
  optional?: boolean
}

/**
 * Download the artifact each source names among the Pahkat artifacts the
 * build uploaded for the package `pkg`, into `dir` under its own name. An
 * unsigned Windows installer (`.UNSIGNED.` in its name, from an outto build
 * whose signing failed) is never published.
 */
export async function downloadArtifacts(
  pkg: string,
  sources: ArtifactSource[],
  dir: string,
): Promise<Artifact[]> {
  const artifacts: Artifact[] = []
  for (const [index, { name, optional, ...artifact }] of sources.entries()) {
    const pattern = pahkatArtifactPath(pkg, name)
    const into = path.join(dir, String(index))
    await Deno.mkdir(into)
    try {
      await builder.downloadArtifacts(pattern, into)
    } catch (e) {
      if (!optional) {
        throw ExpectedError.create(
          e instanceof Error ? e : new Error(String(e)),
          `No build artifact matches ${pattern}`,
        )
      }
    }
    const found = await globFiles("**/*", { root: into })
    const signed = found.filter((file) => {
      const unsigned = path.basename(file).includes(".UNSIGNED.")
      if (unsigned) {
        logger.warning(`Not publishing an unsigned installer: ${file}`)
      }
      return !unsigned
    })
    if (signed.length > 1) {
      throw ExpectedError.create(
        `${pattern} matches more than one artifact: ${signed.join(", ")}`,
      )
    }
    if (signed.length === 0) {
      if (optional) {
        logger.warning(`No signed artifact matches ${pattern}; leaving it out`)
        continue
      }
      throw ExpectedError.create(`No signed artifact matches ${pattern}`)
    }
    const file = path.join(into, pahkatArtifactName(signed[0]))
    await Deno.rename(signed[0], file)
    artifacts.push({ ...artifact, path: file })
  }
  return artifacts
}

/**
 * The licence GitHub recognises in the repository being built, as an SPDX
 * id, and its file at the commit being built.
 */
export async function repositoryLicense(): Promise<
  Pick<Metadata, "license" | "licenseUrl">
> {
  const repo = builder.env.repoPath
  const { code, stdout, stderr } = await ghWithRetry(
    ["api", `repos/${repo}/license`],
    { capture: true },
  )
  if (code !== 0 && /HTTP 404/.test(stderr)) {
    throw ExpectedError.create(`GitHub finds no licence in ${repo}`)
  }
  if (code !== 0) {
    throw new Error(`Could not ask GitHub for ${repo}'s licence: ${stderr}`)
  }
  const answer = JSON.parse(new TextDecoder().decode(stdout)) as {
    path?: string
    license?: { spdx_id?: string | null } | null
  }
  const spdx = answer.license?.spdx_id
  if (!spdx || spdx === "NOASSERTION" || !answer.path) {
    throw ExpectedError.create(
      `GitHub does not recognise the licence in ${repo}, so its releases cannot name one`,
    )
  }
  const file = answer.path.split("/").map(encodeURIComponent).join("/")
  return {
    license: spdx,
    licenseUrl: `https://github.com/${repo}/blob/${builder.env.commit}/${file}`,
  }
}

const METADATA = "pahkat.styx"

/** Every value quoted, as Styx reads it, except the enums', which are bare. */
function quote(text: string): string {
  // deno-lint-ignore no-control-regex
  return `"${text.replace(/[\\"\x00-\x1f\x7f]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\\\"
      case '"':
        return '\\"'
      case "\n":
        return "\\n"
      case "\r":
        return "\\r"
      case "\t":
        return "\\t"
      default:
        return `\\u{${c.charCodeAt(0).toString(16)}}`
    }
  })}"`
}

/**
 * The pahkat.styx (upload.metadata) of a release with `metadata` and
 * `artifacts`, by the file name each is published under.
 */
export function pahkatStyx(
  metadata: Metadata,
  artifacts: Map<string, Artifact>,
): string {
  const lines: string[] = []
  const map = (field: string, entries: [string, string][]) => {
    if (entries.length === 0) return
    lines.push(`${field} {`)
    for (const [key, value] of entries) lines.push(`    ${key} ${value}`)
    lines.push("}")
  }
  const texts = (record: Record<string, string> | undefined) =>
    Object.entries(record ?? {}).map(([key, value]): [string, string] => [
      quote(key),
      quote(value),
    ])
  const seq = (field: string, items: string[] | undefined) => {
    if (items != null && items.length > 0) {
      lines.push(`${field} (${items.map(quote).join(" ")})`)
    }
  }

  map("names", texts(metadata.names))
  map("descriptions", texts(metadata.descriptions))
  lines.push(`authors (${metadata.authors.map(quote).join(" ")})`)
  lines.push(`license ${quote(metadata.license)}`)
  if (metadata.licenseUrl != null) {
    lines.push(`license-url ${quote(metadata.licenseUrl)}`)
  }
  seq("languages", metadata.languages)
  seq("tags", metadata.tags)
  map(
    "dependencies",
    Object.entries(metadata.dependencies ?? {}).map((
      [name, version],
    ): [string, string] => [quote(name), version == null ? "@" : quote(version)]),
  )
  lines.push("artifacts {")
  for (const [name, artifact] of artifacts) {
    lines.push(`    ${quote(name)} {`)
    lines.push(`        kind ${artifact.kind}`)
    if (artifact.outtoId != null) {
      lines.push(`        outto-id ${quote(artifact.outtoId)}`)
    }
    if (artifact.os != null && artifact.os.length > 0) {
      lines.push(`        os (${artifact.os.join(" ")})`)
    }
    if (artifact.arch != null && artifact.arch.length > 0) {
      lines.push(`        arch (${artifact.arch.join(" ")})`)
    }
    if (artifact.minOsVersion != null) {
      lines.push(`        min-os-version ${quote(artifact.minOsVersion)}`)
    }
    lines.push("    }")
  }
  lines.push("}")
  return lines.join("\n") + "\n"
}

/**
 * Publish a release: copy its artifacts into a directory of their own with
 * its pahkat.styx, write BLAKE3SUMS over exactly those, signed with the CI
 * key and a trusted comment naming the package, and `pahkat upload` it.
 */
export async function publishRelease(pahkat: PahkatRelease): Promise<void> {
  const name = `${PAHKAT_REPOSITORY}/${pahkat.package}`
  if (!VERSION.test(pahkat.version)) {
    throw ExpectedError.create(
      `${pahkat.version} is not a Pahkat version, so ${name} cannot be published with it`,
    )
  }
  if (Object.keys(pahkat.metadata.names).length === 0) {
    throw ExpectedError.create(`${name} has no name to publish it under`)
  }

  using dir = await makeTempDir({ prefix: "pahkat-release-" })
  const artifacts = new Map<string, Artifact>()
  for (const artifact of pahkat.artifacts) {
    const file = path.basename(artifact.path)
    if (
      artifacts.has(file) ||
      [METADATA, "BLAKE3SUMS", "BLAKE3SUMS.minisig"].includes(file)
    ) {
      throw ExpectedError.create(
        `${name} ${pahkat.version} cannot have two files named ${file}`,
      )
    }
    artifacts.set(file, artifact)
    await Deno.copyFile(artifact.path, path.join(dir.path, file))
  }
  const metadata = pahkatStyx(pahkat.metadata, artifacts)
  await Deno.writeTextFile(path.join(dir.path, METADATA), metadata)
  logger.info(`${name} ${pahkat.version}, ${METADATA}:\n${metadata}`)

  await createSignedChecksums(
    [...artifacts.keys(), METADATA],
    await builder.ciKey(),
    release(builder.env, {
      tag: pahkat.tag,
      version: pahkat.version,
      package: name,
    }),
    dir.path,
  )

  await upload(dir.path, `${name} ${pahkat.version}`, pahkat.cli)
}

/** What `pahkat upload --json` and the client commands print. */
type Outcome = {
  outcome?: string
  upload?: number
  package?: string
  version?: string
  reason?: string
}

function outcome(stdout: Uint8Array): Outcome {
  try {
    return JSON.parse(new TextDecoder().decode(stdout)) as Outcome
  } catch {
    return {}
  }
}

/** Runs of `pahkat upload` before a failure fails the step. */
const UPLOAD_ATTEMPTS = 3
const UPLOAD_RETRY_DELAY_MS = 30_000

/**
 * `pahkat upload` the release prepared in `dir`. It exits 0 when the server
 * committed it, 1 when the server refused it, which running it again would
 * only repeat, and 2 when it failed in a way a fresh run with a fresh
 * token may fix (upload.client-outcome).
 */
async function upload(
  dir: string,
  release: string,
  cli?: string,
): Promise<void> {
  const pahkat = cli ?? await pahkatCli()
  const job = Deno.env.get("BUILDKITE_BUILD_URL")
  const build = job == null ? [] : [
    "--build",
    `job=${job}${builder.env.jobId ? `#${builder.env.jobId}` : ""}`,
  ]
  let opened: number | undefined

  for (let attempt = 1;; attempt++) {
    const token = await builder.pahkatUploadToken(PAHKAT_REPOSITORY)
    const { code, stdout } = await new Deno.Command(pahkat, {
      args: ["upload", dir, "--server", PAHKAT_SERVER, "--json", ...build],
      env: { PAHKAT_UPLOAD_TOKEN: token },
      stdout: "piped",
      stderr: "inherit",
    }).output()
    const result = outcome(stdout)

    if (code === 0) {
      logger.info(
        `Published ${release} to ${PAHKAT_SERVER} (upload ${result.upload})`,
      )
      return
    }
    if (code === 1) {
      const earlier = opened == null
        ? ""
        : ` (an earlier attempt failed after opening upload ${opened}, which may have published it)`
      throw ExpectedError.create(
        `${PAHKAT_SERVER} refused ${release}${earlier}: ${result.reason}`,
      )
    }

    opened = result.upload ?? opened
    const reason = result.reason ?? `pahkat upload exited with ${code}`
    if (attempt === UPLOAD_ATTEMPTS) {
      throw new Error(
        `Could not publish ${release} to ${PAHKAT_SERVER} in ${UPLOAD_ATTEMPTS} attempts: ${reason}`,
      )
    }
    logger.warning(
      `Publishing ${release} failed (attempt ${attempt} of ${UPLOAD_ATTEMPTS}): ${reason}. Trying again with a fresh token in ${
        UPLOAD_RETRY_DELAY_MS / 1000
      }s`,
    )
    await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS))
  }
}

/**
 * Install `packages`, named in full such as `main/kbdgen`, from the Pahkat
 * server into the client directory `dir`, following `channel`; a directory
 * without a config gets one first. Returns where each box package is
 * unpacked, `<dir>/packages/<repository>/<id>`.
 */
export async function installPackages(
  dir: string,
  packages: string[],
  channel: "stable" | "testing" | "dev" = "stable",
): Promise<string[]> {
  const pahkat = await pahkatCli()
  const run = async (args: string[]) => {
    const { code, stdout } = await new Deno.Command(pahkat, {
      args: ["--dir", dir, "--json", ...args],
      stdout: "piped",
      stderr: "inherit",
    }).output()
    if (code !== 0) {
      throw new Error(
        `pahkat ${args.join(" ")} exited with ${code}: ${
          outcome(stdout).reason ?? "see its output above"
        }`,
      )
    }
  }

  if (!await exists(path.join(dir, "config.styx"))) {
    await run(["init", "--server", PAHKAT_SERVER, "--channel", channel])
  }
  await run(["install", "--yes", ...packages])
  return packages.map((name) => path.join(dir, "packages", ...name.split("/")))
}
