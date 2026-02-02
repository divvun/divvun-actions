import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { Tar, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const TARGETS = [
  "x86_64-unknown-linux-musl",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
  "x86_64-pc-windows-msvc",
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

function os(target: string): string {
  if (target.includes("windows")) {
    return "windows"
  } else if (target.includes("apple")) {
    return "macos"
  } else if (target.includes("linux")) {
    return "linux"
  }

  throw new Error(`Unknown OS for target: ${target}`)
}

export async function pipelineGut(): Promise<BuildkitePipeline> {
  // Load version from Cargo.toml
  const cargoTomlText = await Deno.readTextFile("Cargo.toml")
  const versionMatch = cargoTomlText.match(/version\s*=\s*"(.*?)"/)
  const version = versionMatch?.[1]

  if (typeof version !== "string") {
    throw new Error("Could not determine version from Cargo.toml")
  }

  const steps: CommandStep[] = []

  // Lint and format check step
  steps.push(command({
    label: "Lint & Format",
    key: "lint",
    command: [
      "echo '--- Checking formatting'",
      "cargo fmt --check",
      "echo '--- Running clippy'",
      "cargo clippy -- -D warnings",
    ],
    agents: {
      queue: "linux",
    },
  }))

  // Test step
  steps.push(command({
    label: "Test",
    key: "test",
    command: [
      "echo '--- Running tests'",
      "cargo test",
    ],
    agents: {
      queue: "linux",
    },
    depends_on: "lint",
  }))

  // Build steps for each target
  for (const target of TARGETS) {
    const artifactName = `gut${target.includes("windows") ? ".exe" : ""}`
    const targetFile = path.join("target", target, "release", artifactName)

    if (target.includes("apple")) {
      // macOS targets: Split into build and sign steps
      steps.push(command({
        label: `Build (${target})`,
        key: `build-${target}`,
        command: [
          "echo '--- Installing target'",
          `rustup target add ${target}`,
          "echo '--- Building'",
          `cargo build --release --target ${target}`,
          `mv ${targetFile} ./gut-unsigned-${target}`,
          `buildkite-agent artifact upload gut-unsigned-${target}`,
        ],
        agents: {
          queue: "macos",
        },
        depends_on: "test",
      }))

      steps.push(command({
        label: `Sign (${target})`,
        key: `sign-${target}`,
        command: [
          "echo '--- Downloading unsigned binary'",
          `buildkite-agent artifact download gut-unsigned-${target} .`,
          "echo '--- Signing'",
          `divvun-actions run macos-sign ./gut-unsigned-${target}`,
          "echo '--- Uploading signed binary'",
          `mv ./gut-unsigned-${target} ./gut-${target}`,
          `buildkite-agent artifact upload gut-${target}`,
        ],
        agents: {
          queue: "linux",
        },
        depends_on: `build-${target}`,
      }))
    } else if (os(target) === "windows") {
      // Windows targets: Build and upload directly
      steps.push(command({
        label: `Build (${target})`,
        key: `build-${target}`,
        command: [
          `$$env:PATH = "C:\\MSYS2\\usr\\bin;" + $$env:PATH; rustup target add ${target}; cargo build --release --target ${target}`,
          `mv ${targetFile} .\\${artifactName}-${target}`,
          `buildkite-agent artifact upload ${artifactName}-${target}`,
        ],
        agents: {
          queue: "windows",
        },
        depends_on: "test",
      }))
    } else {
      // Linux targets: Build and upload directly
      steps.push(command({
        label: `Build (${target})`,
        key: `build-${target}`,
        command: [
          "echo '--- Installing target'",
          `rustup target add ${target}`,
          "echo '--- Building'",
          `cargo build --release --target ${target}`,
          `mv ${targetFile} ./gut-${target}`,
          `buildkite-agent artifact upload gut-${target}`,
        ],
        agents: {
          queue: target.includes("-musl") ? "alpine" : "linux",
        },
        depends_on: "test",
      }))
    }
  }

  const pipeline: BuildkitePipeline = {
    steps: [
      {
        group: "Build",
        key: "build",
        steps,
      },
    ],
  }

  // Add publish step for releases
  if (builder.env.tag && builder.env.tag.match(/^v/)) {
    pipeline.steps.push(
      command({
        label: "Publish",
        command: "divvun-actions run gut-publish",
        agents: {
          queue: "linux",
        },
        depends_on: "build",
      }),
    )
  }

  return pipeline
}

export async function runGutPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  using tempDir = await makeTempDir()

  // Download all artifacts
  await Promise.all(
    TARGETS.map((target) => {
      if (target.includes("windows")) {
        return builder.downloadArtifacts(`gut.exe-${target}`, tempDir.path)
      }
      return builder.downloadArtifacts(`gut-${target}`, tempDir.path)
    }),
  )

  using archivePath = await makeTempDir({ prefix: "gut-" })

  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const ext = target.includes("windows") ? "zip" : "tgz"
    const outPath = path.join(
      archivePath.path,
      `gut-${target}-${builder.env.tag!}.${ext}`,
    )
    const inputPath = path.join(
      tempDir.path,
      target.includes("windows") ? `gut.exe-${target}` : `gut-${target}`,
    )

    if (!target.includes("windows")) {
      await Deno.chmod(inputPath, 0o755)
    }

    // Create staging directory with the binary inside
    const stagingDir = `gut-${target}-${builder.env.tag!}`
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(
      inputPath,
      path.join(stagingDir, target.includes("windows") ? "gut.exe" : "gut"),
    )

    if (target.includes("windows")) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }

    allArtifacts.push(outPath)
  }

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(
    builder.env.tag!,
    [`${archivePath.path}/*`],
    { latest: true },
  )
}
