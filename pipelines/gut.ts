import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { Tar, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const platforms = {
  macos: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  linux: ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

const ALL_TARGETS = Object.values(platforms).flat()

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline function
// ─────────────────────────────────────────────────────────────────────────────

export function pipelineGut(): BuildkitePipeline {
  const steps: CommandStep[] = []
  const isRelease = builder.env.tag?.match(/^v/) != null

  if (!isRelease) {
    steps.push(createLintStep())
  }

  steps.push(createTestStep(!isRelease))

  const buildStepKeys: string[] = []

  for (const [platform, archs] of Object.entries(platforms)) {
    for (const arch of archs) {
      const buildKey = `build-${platform}-${arch}`
      buildStepKeys.push(buildKey)

      if (platform === "windows") {
        steps.push(createWindowsBuildStep(arch))
        if (isRelease) {
          buildStepKeys.push(`sign-windows-${arch}`)
          steps.push(createWindowsSignStep(arch, buildKey))
        }
      } else if (platform === "macos") {
        steps.push(createMacosBuildStep(arch))
        if (isRelease) {
          buildStepKeys.push(`sign-macos-${arch}`)
          steps.push(createMacosSignStep(arch, buildKey))
        }
      } else {
        steps.push(createLinuxBuildStep(arch))
      }
    }
  }

  if (isRelease) {
    steps.push(createPublishStep(buildStepKeys))
  }

  return { steps }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step creation functions
// ─────────────────────────────────────────────────────────────────────────────

function createLintStep(): CommandStep {
  return command({
    label: "Lint & Format",
    key: "lint",
    command: [
      "echo '--- Checking formatting'",
      "cargo fmt --check",
      "echo '--- Running clippy'",
      "cargo clippy -- -D warnings",
    ],
    agents: { queue: "linux" },
    plugins: [cachePlugin("lint")],
  })
}

function createTestStep(dependsOnLint: boolean): CommandStep {
  return command({
    label: "Test",
    key: "test",
    command: [
      "echo '--- Running tests'",
      "cargo test",
    ],
    agents: { queue: "linux" },
    depends_on: dependsOnLint ? "lint" : undefined,
    plugins: [cachePlugin("test")],
  })
}

function createSignStep(opts: {
  platform: string
  arch: string
  ext: string
  downloadPath: string
  signCommand: string
  buildKey: string
}): CommandStep {
  const { platform, arch, ext, downloadPath, signCommand, buildKey } = opts
  const binaryPath = `target/${arch}/release/gut${ext}`
  const signedPath = `signed/${binaryPath}`

  return command({
    key: `sign-${platform}-${arch}`,
    label: `Sign (${arch})`,
    agents: { queue: "linux" },
    command: [
      "echo '--- Downloading unsigned binary'",
      `buildkite-agent artifact download '${downloadPath}' .`,
      "echo '--- Signing'",
      signCommand,
      "echo '--- Uploading signed binary'",
      `mkdir -p signed/target/${arch}/release`,
      `mv ${binaryPath} ${signedPath}`,
      `buildkite-agent artifact upload ${signedPath}`,
    ],
    depends_on: buildKey,
  })
}

function createWindowsBuildStep(arch: string): CommandStep {
  return command({
    key: `build-windows-${arch}`,
    label: `Build (${arch})`,
    agents: { queue: "windows" },
    command: [
      `msvc-env ${
        msvcEnvCmd(arch)
      } | Invoke-Expression; cargo build --release --target ${arch}`,
      `buildkite-agent artifact upload target/${arch}/release/gut.exe`,
    ],
    depends_on: "test",
    plugins: [cachePlugin(arch)],
  })
}

function createWindowsSignStep(arch: string, buildKey: string): CommandStep {
  return createSignStep({
    platform: "windows",
    arch,
    ext: ".exe",
    downloadPath: `target\\${arch}\\release\\gut.exe`,
    signCommand: `divvun-actions sign target/${arch}/release/gut.exe`,
    buildKey,
  })
}

function createMacosBuildStep(arch: string): CommandStep {
  return command({
    key: `build-macos-${arch}`,
    label: `Build (${arch})`,
    agents: { queue: "macos" },
    command: [
      `rustup target add ${arch}`,
      `cargo build --release --target ${arch}`,
      `buildkite-agent artifact upload target/${arch}/release/gut`,
    ],
    depends_on: "test",
  })
}

function createMacosSignStep(arch: string, buildKey: string): CommandStep {
  return createSignStep({
    platform: "macos",
    arch,
    ext: "",
    downloadPath: `target/${arch}/release/gut`,
    signCommand: `divvun-actions run macos-sign target/${arch}/release/gut`,
    buildKey,
  })
}

function createLinuxBuildStep(arch: string): CommandStep {
  return command({
    key: `build-linux-${arch}`,
    label: `Build (${arch})`,
    agents: { queue: arch.includes("-musl") ? "alpine" : "linux" },
    command: [
      `rustup target add ${arch}`,
      `cargo build --release --target ${arch}`,
      `buildkite-agent artifact upload target/${arch}/release/gut`,
    ],
    depends_on: "test",
    plugins: [cachePlugin(arch)],
  })
}

function createPublishStep(dependsOn: string[]): CommandStep {
  return command({
    label: "Publish",
    command: "divvun-actions run gut-publish",
    agents: { queue: "linux" },
    depends_on: dependsOn,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Publishing functions
// ─────────────────────────────────────────────────────────────────────────────

async function downloadAllArtifacts(tempDir: string): Promise<void> {
  await builder.downloadArtifacts(
    "signed/target/*-apple-darwin/release/gut",
    tempDir,
  )
  await builder.downloadArtifacts("target/*-linux-*/release/gut", tempDir)
  await builder.downloadArtifacts(
    "signed/target/*-pc-windows-msvc/release/gut.exe",
    tempDir,
  )
}

async function createArchiveForTarget(
  target: string,
  tempDir: string,
  archiveDir: string,
  tag: string,
): Promise<string> {
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""
  const archiveExt = isWindows ? "zip" : "tgz"
  const binaryName = `gut${ext}`
  const useSignedPath = target.includes("apple-darwin") || isWindows

  const inputPath = path.join(
    tempDir,
    ...(useSignedPath ? ["signed", "target"] : ["target"]),
    target,
    "release",
    binaryName,
  )

  const archiveName = `gut-${target}-${tag}`
  const outPath = path.join(archiveDir, `${archiveName}.${archiveExt}`)

  if (!isWindows) {
    await Deno.chmod(inputPath, 0o755)
  }

  const stagingDir = path.join(archiveDir, archiveName)
  await Deno.mkdir(stagingDir)
  await Deno.copyFile(inputPath, path.join(stagingDir, binaryName))

  if (isWindows) {
    await Zip.create([stagingDir], outPath)
  } else {
    await Tar.createFlatTgz([stagingDir], outPath)
  }

  return outPath
}

export async function runGutPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish")
  }
  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  using tempDir = await makeTempDir()
  using archiveDir = await makeTempDir({ prefix: "gut-" })

  await downloadAllArtifacts(tempDir.path)

  const allArtifacts = await Promise.all(
    ALL_TARGETS.map((target) =>
      createArchiveForTarget(
        target,
        tempDir.path,
        archiveDir.path,
        builder.env.tag!,
      )
    ),
  )

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(builder.env.tag!, allArtifacts, { latest: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

function msvcEnvCmd(arch: string): string {
  return arch.startsWith("aarch64") ? "arm64" : "x64"
}

function cachePlugin(keyExtra: string) {
  return {
    "cache#v1.7.0": {
      manifest: "Cargo.lock",
      path: "target",
      restore: "file",
      save: "file",
      "key-extra": keyExtra,
    },
  }
}
