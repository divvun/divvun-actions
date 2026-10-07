import * as fs from "@std/fs"
import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import {
  KBDI_BUILDS,
  KBDI_NAME,
  kbdiPrerelease,
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

const msvcEnvCmd = (arch: string) => {
  if (arch.startsWith("aarch64")) {
    return "arm64"
  }
  if (arch.startsWith("i686")) {
    return "x86"
  }
  return "x64"
}

/**
 * Builds and signs kbdi for every KBDI_BUILDS target on every push, each in
 * its own group, and from kbdi's main and v4 branches publishes them to the
 * branch's prerelease (kbdiPrerelease).
 */
export function pipelineKbdi(): BuildkitePipeline {
  const pipeline: BuildkitePipeline = { steps: [] }
  const buildStepKeys: string[] = []

  for (const { target: arch } of KBDI_BUILDS) {
    const buildKey = `build-windows-${arch}`
    buildStepKeys.push(buildKey)
    pipeline.steps.push({
      group: `windows ${arch}`,
      steps: [command({
        key: buildKey,
        agents: {
          queue: "windows",
        },
        label: "Build and sign",
        command: [
          // rustup 1.28+ installs the toolchain and targets that
          // rust-toolchain.toml pins only when asked to.
          "rustup toolchain install",
          `msvc-env ${
            msvcEnvCmd(arch)
          } | Invoke-Expression; cargo build --locked --bin kbdi --release --target ${arch}`,
          `divvun-actions sign ${binaryPath(arch)}`,
          `buildkite-agent artifact upload ${binaryPath(arch)}`,
        ],
        plugins: [
          {
            "cache#v1.7.0": {
              manifest: "Cargo.lock",
              path: "target",
              restore: "file",
              save: "file",
              "key-extra": arch,
            },
          },
        ],
      })],
    })
  }

  const prerelease = kbdiPrerelease()
  if (prerelease) {
    pipeline.steps.push(command({
      label: `Publish (${prerelease.tag})`,
      command: "divvun-actions run kbdi-publish",
      depends_on: buildStepKeys,
      agents: {
        queue: "linux",
      },
      concurrency: 1,
      concurrency_group: `kbdi/${prerelease.tag}`,
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
 * Replaces the assets of this branch's prerelease (kbdiPrerelease) with this
 * build's kbdi for every target, as `kbdi_<target>_<version>.exe`, with a
 * minisigned BLAKE3SUMS of them.
 */
export async function runKbdiPublish() {
  const prerelease = kbdiPrerelease()
  if (!prerelease || !builder.env.repo) {
    throw new Error(
      "Publishing kbdi needs a push to the main or v4 branch",
    )
  }
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    package?: { version?: string }
  }
  const version = versionAsDev(
    cargo.package?.version,
    builder.env.buildTimestamp,
    prerelease.buildNumber ? builder.env.buildNumber : undefined,
  )

  using work = await makeTempDir({ prefix: "kbdi-publish-" })
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
  logger.info(`Publishing to ${prerelease.tag}: ${names.join(", ")}`)
  await new GitHub(builder.env.repo).updateRelease(
    prerelease.tag,
    [
      ...names.map((name) => path.join(assets, name)),
      checksumFile,
      signatureFile,
    ],
    {
      draft: false,
      prerelease: true,
      name: prerelease.name(version),
    },
  )
}
