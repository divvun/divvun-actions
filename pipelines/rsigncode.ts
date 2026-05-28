import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import { Tar, versionAsDev, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const TARGETS = [
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
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
  if (target.includes("linux")) return "linux"
  if (target.includes("windows")) return "windows"
  if (target.includes("apple")) return "macos"
  throw new Error(`Unknown queue for target: ${target}`)
}

function binaryName(target: string): string {
  return target.includes("windows") ? "rsigncode.exe" : "rsigncode"
}

export function pipelineRsigncode(): BuildkitePipeline {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  const steps: BuildkitePipeline["steps"] = []
  const buildKeys: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const bin = binaryName(target)
    const binPath = `target/${target}/release/${bin}`
    const buildKey = `build-${target}`
    buildKeys.push(buildKey)

    if (isWindows) {
      const llvmArch = target.includes("aarch64") ? "ARM64" : "x64"
      steps.push(command({
        key: buildKey,
        label: target,
        command: [
          `$$env:PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\Llvm\\${llvmArch}\\bin;C:\\MSYS2\\usr\\bin;" + $$env:PATH; cargo build --release --locked -p rsigncode-cli --target ${target}`,
          `buildkite-agent artifact upload ${binPath}`,
        ],
        agents: { queue: "windows" },
      }))
    } else {
      steps.push(command({
        key: buildKey,
        label: target,
        command: [
          `cargo build --release --locked -p rsigncode-cli --target ${target}`,
          `buildkite-agent artifact upload ${binPath}`,
        ],
        agents: { queue: queue(target) },
      }))
    }
  }

  if (isRelease || isMainBranch) {
    steps.push(
      command({
        label: `Publish (${isRelease ? "Release" : "Dev"})`,
        command: "divvun-actions run rsigncode-publish",
        agents: { queue: "linux" },
        depends_on: buildKeys,
      }),
    )
  }

  return { steps }
}

export async function runRsigncodePublish() {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error("rsigncode-publish requires a version tag or main branch")
  }
  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  // Version: tagged release uses the tag verbatim; dev-latest derives from
  // crates/rsigncode-cli/Cargo.toml + build timestamp + build number.
  let version: string
  if (isRelease) {
    version = builder.env.tag!
  } else {
    const cargoTomlText = await Deno.readTextFile(
      "crates/rsigncode-cli/Cargo.toml",
    )
    const versionMatch = cargoTomlText.match(/version\s*=\s*"(.*?)"/)
    const cargoVersion = versionMatch?.[1]
    if (typeof cargoVersion !== "string") {
      throw new Error(
        "Could not determine version from crates/rsigncode-cli/Cargo.toml",
      )
    }
    version = `v${
      versionAsDev(
        cargoVersion,
        builder.env.buildTimestamp,
        builder.env.buildNumber,
      )
    }`
  }

  using tempDir = await makeTempDir()
  await Promise.all(
    TARGETS.map((target) =>
      builder.downloadArtifacts(
        `target/${target}/release/${binaryName(target)}`,
        tempDir.path,
      )
    ),
  )

  using archivePath = await makeTempDir({ prefix: "rsigncode-" })
  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const bin = binaryName(target)
    const inputPath = path.join(
      tempDir.path,
      "target",
      target,
      "release",
      bin,
    )

    if (!isWindows) {
      await Deno.chmod(inputPath, 0o755)
    }

    const stagingDir = path.join(
      tempDir.path,
      `rsigncode-${target}-${version}`,
    )
    await Deno.mkdir(stagingDir, { recursive: true })
    await Deno.copyFile(inputPath, path.join(stagingDir, bin))

    const ext = isWindows ? "zip" : "tgz"
    const outPath = path.join(
      archivePath.path,
      `rsigncode-${target}-${version}.${ext}`,
    )
    if (isWindows) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }
    allArtifacts.push(outPath)
  }

  const { checksumFile, signatureFile } = await createSignedChecksums(
    allArtifacts,
    await builder.secrets(),
  )
  await fs.copy(
    checksumFile,
    path.join(archivePath.path, checksumFile),
    { overwrite: true },
  )
  await fs.copy(
    signatureFile,
    path.join(archivePath.path, signatureFile),
    { overwrite: true },
  )
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
      { draft: false, prerelease: true, name: version },
    )
  }
}
