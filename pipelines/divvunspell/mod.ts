import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "../../util/github.ts"
import { Tar, Zip } from "../../util/shared.ts"
import { makeTempDir } from "../../util/temp.ts"

const binPlatforms = {
  macos: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  linux: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

const libPlatforms = {
  macos: [
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
  ],
  linux: [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "x86_64-linux-android",
  ],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

function buildLib(arch: string): { cmd: string; args: string[] } {
  if (arch.includes("android")) {
    return {
      cmd: "cargo",
      args: [
        "ndk",
        "--target",
        arch,
        "build",
        "--lib",
        "--release",
        "--features",
        "internal_ffi",
        "-v",
      ],
    }
  }

  if (arch === "aarch64-unknown-linux-gnu") {
    return {
      cmd: "cross",
      args: [
        "build",
        "--lib",
        "--release",
        "--target",
        arch,
        "--features",
        "internal_ffi",
      ],
    }
  }

  return {
    cmd: "cargo",
    args: [
      "build",
      "--lib",
      "--release",
      "--target",
      arch,
      "--features",
      "internal_ffi",
    ],
  }
}

function buildBin(arch: string): { cmd: string; args: string[] } {
  const args = ["build", "--bin", "divvunspell", "--release", "--target", arch]
  const cmd = arch === "aarch64-unknown-linux-gnu" ? "cross" : "cargo"
  return { cmd, args }
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export function pipelineDivvunspell() {
  const binSteps = []
  const libSteps = []

  let isPublishLib = false

  if (builder.env.tag?.startsWith("libdivvunspell/v")) {
    isPublishLib = true
  }

  if (!isPublishLib) {
    for (const [os, archs] of Object.entries(binPlatforms)) {
      for (const arch of archs) {
        const { cmd, args } = buildBin(arch)

        if (os === "windows") {
          binSteps.push(command({
            agents: {
              queue: os,
            },
            label: arch,
            command: [
              `${cmd} ${args.join(" ")}`,
              `mv target/${arch}/release/divvunspell.exe divvunspell-${arch}.exe`,
              `buildkite-agent artifact upload divvunspell-${arch}.exe`,
            ],
          }))
        } else {
          binSteps.push(command({
            agents: {
              queue: os,
            },
            label: arch,
            command: [
              `${cmd} ${args.join(" ")}`,
              `mv target/${arch}/release/divvunspell divvunspell-${arch}`,
              `buildkite-agent artifact upload divvunspell-${arch}`,
            ],
          }))
        }
      }
    }
  }

  for (const [os, archs] of Object.entries(libPlatforms)) {
    for (const arch of archs) {
      const { cmd, args } = buildLib(arch)

      if (os === "windows") {
        libSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            `${cmd} ${args.join(" ")}`,
            `mv target/${arch}/release/divvunspell.dll divvunspell-${arch}.dll`,
            `buildkite-agent artifact upload divvunspell-${arch}.dll`,
          ],
        }))
      } else {
        const ext = os === "linux" ? "so" : "dylib"
        const libName = `libdivvunspell-${arch}.${ext}`
        libSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            `${cmd} ${args.join(" ")}`,
            `mv target/${arch}/release/libdivvunspell.${ext} ${libName}`,
            `buildkite-agent artifact upload ${libName}`,
          ],
        }))
      }
    }
  }

  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  if (binSteps.length > 0) {
    pipeline.steps.push({
      group: "Build Binaries",
      key: "build-binaries",
      steps: binSteps,
    })
  }

  pipeline.steps.push({
    group: "Build Libraries",
    key: "build-libraries",
    steps: libSteps,
  })

  if (isPublishLib) {
    pipeline.steps.push(command({
      label: "Publish",
      command: "divvun-actions run libdivvunspell-publish",
      agents: {
        queue: "linux",
      },
      depends_on: "build-libraries",
    }))
  }

  return pipeline
}

export async function runLibdivvunspellPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish libdivvunspell")
  }

  if (!builder.env.tag.startsWith("libdivvunspell/v")) {
    throw new Error(
      `Tag ${builder.env.tag} does not start with libdivvunspell/v, cannot publish libdivvunspell`,
    )
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish libdivvunspell")
  }

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(`libdivvunspell-*`, tempDir.path)
  await builder.downloadArtifacts(`divvunspell-*`, tempDir.path)

  using archivePath = await makeTempDir({ prefix: "libdivvunspell-" })
  const [_tag, version] = builder.env.tag.split("/")

  const artifacts = []

  for (const [os, targets] of Object.entries(libPlatforms)) {
    for (const target of targets) {
      const libExt = os === "linux" ? "so" : os === "macos" ? "dylib" : "dll"
      const libFileName = os === "windows"
        ? `divvunspell.dll`
        : `libdivvunspell.${libExt}`

      const artifactName = `${
        os === "windows" ? "" : "lib"
      }divvunspell-${target}.${libExt}`
      const inputPath = `${tempDir.path}/${artifactName}`

      const archiveFilePath = tempDir.path + "/" + target
      const libPath = archiveFilePath + "/lib"
      await Deno.mkdir(libPath, { recursive: true })
      await Deno.rename(inputPath, `${libPath}/${libFileName}`)

      const ext = os === "windows" ? "zip" : "tgz"
      const outPath =
        `${archivePath.path}/libdivvunspell-${target}-${version}.${ext}`

      if (ext === "zip") {
        await Zip.create([libPath], outPath)
      } else {
        await Tar.createFlatTgz([libPath], outPath)
      }

      artifacts.push(outPath)
    }
  }

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(builder.env.tag, artifacts, false, false)
}
