import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import { Tar, Zip, versionAsDev } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const TARGETS = [
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
]

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

function queue(target: string): string {
  if (target.includes("-musl")) return "alpine"
  if (target.includes("windows")) return "windows"
  if (target.includes("apple")) return "macos"
  throw new Error(`Unknown queue for target: ${target}`)
}

export function pipelineBox(): BuildkitePipeline {
  const isRelease = builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  const buildSteps: CommandStep[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const binaryName = isWindows ? "box.exe" : "box"
    const artifactName = isWindows ? `box-${target}.exe` : `box-${target}`
    const targetFile = path.join("target", target, "release", binaryName)

    if (isWindows) {
      const llvmArch = target.includes("aarch64") ? "ARM64" : "x64"
      buildSteps.push(command({
        label: `build-${target}`,
        command: [
          `$$env:PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\Llvm\\${llvmArch}\\bin;C:\\MSYS2\\usr\\bin;" + $$env:PATH; cargo build -p box-cli --bin box --release --target ${target}`,
          `mv ${targetFile} .\\${artifactName}`,
          `buildkite-agent artifact upload ${artifactName}`,
        ],
        agents: { queue: "windows" },
      }))
    } else {
      buildSteps.push(command({
        label: `build-${target}`,
        command: [
          `cargo build -p box-cli --bin box --release --target ${target}`,
          `mv ${targetFile} ./${artifactName}`,
          `buildkite-agent artifact upload ${artifactName}`,
        ],
        agents: { queue: queue(target) },
      }))
    }
  }

  const pipeline: BuildkitePipeline = {
    steps: [
      {
        group: "Build",
        key: "build",
        steps: buildSteps,
      },
    ],
  }

  if (isRelease || isMainBranch) {
    pipeline.steps.push(
      command({
        label: `Publish (${isRelease ? "Release" : "Dev"})`,
        command: "divvun-actions run box-publish",
        agents: { queue: "linux" },
        depends_on: "build",
      }),
    )
  }

  return pipeline
}

export async function runBoxPublish() {
  const isRelease = builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error("box-publish requires a version tag or main branch")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  using tempDir = await makeTempDir()

  // Download all artifacts
  await Promise.all(
    TARGETS.map((target) => {
      const artifactName = target.includes("windows")
        ? `box-${target}.exe`
        : `box-${target}`
      return builder.downloadArtifacts(artifactName, tempDir.path)
    }),
  )

  // Determine version string for archive names
  let version: string
  if (isRelease) {
    version = builder.env.tag!
  } else {
    const cargoTomlText = await Deno.readTextFile("Cargo.toml")
    const versionMatch = cargoTomlText.match(/version\s*=\s*"(.*?)"/)
    const cargoVersion = versionMatch?.[1]
    if (typeof cargoVersion !== "string") {
      throw new Error("Could not determine version from Cargo.toml")
    }
    version = versionAsDev(
      cargoVersion,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
  }

  using archivePath = await makeTempDir({ prefix: "box-" })
  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const ext = isWindows ? "zip" : "tgz"
    const outPath = path.join(
      archivePath.path,
      `box-${target}-${version}.${ext}`,
    )
    const inputPath = path.join(
      tempDir.path,
      isWindows ? `box-${target}.exe` : `box-${target}`,
    )

    if (!isWindows) {
      await Deno.chmod(inputPath, 0o755)
    }

    const stagingDir = `box-${target}-${version}`
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(
      inputPath,
      path.join(stagingDir, isWindows ? "box.exe" : "box"),
    )

    if (isWindows) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }

    allArtifacts.push(outPath)
  }

  // Create signed checksums
  const { checksumFile, signatureFile } = await createSignedChecksums(
    allArtifacts,
    await builder.secrets(),
  )

  const checksumDest = path.join(archivePath.path, checksumFile)
  const signatureDest = path.join(archivePath.path, signatureFile)
  await fs.copy(checksumFile, checksumDest, { overwrite: true })
  await fs.copy(signatureFile, signatureDest, { overwrite: true })
  await Deno.remove(checksumFile)
  await Deno.remove(signatureFile)

  const gh = new GitHub(builder.env.repo)

  if (isRelease) {
    await gh.createRelease(
      builder.env.tag!,
      [`${archivePath.path}/*`],
      { latest: true },
    )
  } else {
    await gh.updateRelease(
      "dev-latest",
      [`${archivePath.path}/*`],
      { draft: false, prerelease: true, name: `v${version}` },
    )
  }
}
