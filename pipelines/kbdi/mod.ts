import * as fs from "@std/fs"
import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import {
  isKbdiV4Build,
  KBDI_BUILDS,
  KBDI_NAME,
  KBDI_V4_TAG,
} from "~/actions/kbdi/v4.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { downloadBinary } from "~/util/artifact_download.ts"
import { assetFileName } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import logger from "~/util/log.ts"
import { versionAsDev } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

function binaryPath(triple: string): string {
  return `target/${triple}/release/kbdi.exe`
}

/**
 * The MSVC environment for `triple`'s build. msvc-env provides x64 and arm64
 * environments, and an x64 one would link i686 against x64 libraries, so the
 * i686 build leaves finding MSVC to rustc.
 */
function msvcEnvPrefix(triple: string): string {
  if (triple.startsWith("aarch64")) {
    return "msvc-env arm64 | Invoke-Expression; "
  }
  if (triple.startsWith("x86_64")) {
    return "msvc-env x64 | Invoke-Expression; "
  }
  return ""
}

/**
 * Builds and signs kbdi for every KBDI_BUILDS target on every push, and from
 * the v4 branch publishes them to KBDI_V4_TAG. Production kbdi is released by
 * kbdi's Taskcluster tasks, and nothing here deploys to pahkat.
 */
export function pipelineKbdi(): BuildkitePipeline {
  const pipeline: BuildkitePipeline = { steps: [] }
  const buildStepKeys: string[] = []

  for (const { target: triple } of KBDI_BUILDS) {
    const key = `build-${triple}`
    buildStepKeys.push(key)
    pipeline.steps.push(command({
      key,
      label: `Build and sign ${triple}`,
      agents: { queue: "windows" },
      command: [
        // rustup 1.28+ installs the toolchain and targets that
        // rust-toolchain.toml pins only when asked to.
        "rustup toolchain install",
        `${
          msvcEnvPrefix(triple)
        }cargo build --locked --release --bin kbdi --target ${triple}`,
        `divvun-actions sign ${binaryPath(triple)}`,
        `buildkite-agent artifact upload ${binaryPath(triple)}`,
      ],
      plugins: [{
        "cache#v1.7.0": {
          manifest: "Cargo.lock",
          path: "target",
          restore: "file",
          save: "file",
          "key-extra": triple,
        },
      }],
    }))
  }

  if (isKbdiV4Build()) {
    pipeline.steps.push(command({
      label: `Publish kbdi v4 (${KBDI_V4_TAG})`,
      command: "divvun-actions run kbdi-publish-v4",
      depends_on: buildStepKeys,
      agents: { queue: "linux" },
      concurrency: 1,
      concurrency_group: `kbdi/${KBDI_V4_TAG}`,
    }))
  }

  return pipeline
}

/**
 * The signed kbdi a build step uploaded for `triple`. A Windows agent may
 * store its path with backslashes, which a Linux download keeps in the file
 * name, so the one `kbdi.exe` under the fresh `directory` is taken whatever
 * its path.
 */
async function downloadKbdi(
  triple: string,
  directory: string,
): Promise<string> {
  await downloadBinary(binaryPath(triple), directory)
  const found: string[] = []
  for await (const entry of fs.walk(directory, { includeDirs: false })) {
    if (entry.path.split(/[\\/]/).at(-1) === "kbdi.exe") {
      found.push(entry.path)
    }
  }
  if (found.length !== 1) {
    throw new Error(
      `Expected one kbdi.exe for ${triple}, found ${found.length}`,
    )
  }
  return found[0]
}

/**
 * Replaces KBDI_V4_TAG's assets with this build's kbdi for every target, as
 * `kbdi_<target>_<version>.exe`, with a minisigned BLAKE3SUMS of them.
 */
export async function runKbdiPublishV4() {
  if (!isKbdiV4Build() || !builder.env.repo) {
    throw new Error("Publishing kbdi v4 needs a push to the v4 branch")
  }
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    package?: { version?: string }
  }
  const version = versionAsDev(
    cargo.package?.version,
    builder.env.buildTimestamp,
    undefined,
  )

  using work = await makeTempDir({ prefix: "kbdi-v4-" })
  const assets = path.join(work.path, "assets")
  await Deno.mkdir(assets)

  const names: string[] = []
  for (const { target: triple } of KBDI_BUILDS) {
    const downloads = path.join(work.path, triple)
    await Deno.mkdir(downloads)
    const name = assetFileName(KBDI_NAME, triple, version, "exe")
    await Deno.copyFile(
      await downloadKbdi(triple, downloads),
      path.join(assets, name),
    )
    names.push(name)
  }

  const { checksumFile, signatureFile } = await createSignedChecksums(
    names,
    await builder.secrets(),
    assets,
  )
  logger.info(`Publishing to ${KBDI_V4_TAG}: ${names.join(", ")}`)
  await new GitHub(builder.env.repo).updateRelease(
    KBDI_V4_TAG,
    [
      ...names.map((name) => path.join(assets, name)),
      checksumFile,
      signatureFile,
    ],
    {
      draft: false,
      prerelease: true,
      name: `kbdi v4 ${version}`,
    },
  )
}
