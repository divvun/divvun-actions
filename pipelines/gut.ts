import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { Tar, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const platforms = {
  macos: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  linux: ["x86_64-unknown-linux-musl"],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

const ALL_TARGETS = Object.values(platforms).flat()

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

const msvcEnvCmd = (arch: string) => {
  if (arch.startsWith("aarch64")) {
    return "arm64"
  }
  return "x64"
}

export async function pipelineGut(): Promise<BuildkitePipeline> {
  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  const isRelease = builder.env.tag && builder.env.tag.match(/^v/)

  // Lint and format check step (skip on release tags - code already reviewed)
  if (!isRelease) {
    pipeline.steps.push(command({
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
      plugins: [
        {
          "cache#v1.7.0": {
            manifest: "Cargo.lock",
            path: "target",
            restore: "file",
            save: "file",
            "key-extra": "lint",
          },
        },
      ],
    }))
  }

  // Test step
  pipeline.steps.push(command({
    label: "Test",
    key: "test",
    command: [
      "echo '--- Running tests'",
      "cargo test",
    ],
    agents: {
      queue: "linux",
    },
    depends_on: isRelease ? undefined : "lint",
    plugins: [
      {
        "cache#v1.7.0": {
          manifest: "Cargo.lock",
          path: "target",
          restore: "file",
          save: "file",
          "key-extra": "test",
        },
      },
    ],
  }))

  const buildStepKeys: string[] = []

  for (const [platform, archs] of Object.entries(platforms)) {
    for (const arch of archs) {
      const ext = platform === "windows" ? ".exe" : ""
      const buildKey = `build-${platform}-${arch}`
      buildStepKeys.push(buildKey)

      if (platform === "windows") {
        pipeline.steps.push(command({
          key: buildKey,
          label: `Build (${arch})`,
          agents: {
            queue: "windows",
          },
          command: [
            `msvc-env ${
              msvcEnvCmd(arch)
            } | Invoke-Expression; cargo build --release --target ${arch}`,
            `buildkite-agent artifact upload target/${arch}/release/gut${ext}`,
          ],
          depends_on: "test",
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
        }))

        // Windows: Sign on Linux (osslsigncode is available there)
        const signKey = `sign-${platform}-${arch}`
        buildStepKeys.push(signKey)

        pipeline.steps.push(command({
          key: signKey,
          label: `Sign (${arch})`,
          agents: {
            queue: "linux",
          },
          command: [
            "echo '--- Downloading unsigned binary'",
            `buildkite-agent artifact download target/${arch}/release/gut${ext} .`,
            "echo '--- Signing'",
            `divvun-actions sign target/${arch}/release/gut${ext}`,
            "echo '--- Uploading signed binary'",
            `mkdir -p signed/target/${arch}/release`,
            `mv target/${arch}/release/gut${ext} signed/target/${arch}/release/gut${ext}`,
            `buildkite-agent artifact upload signed/target/${arch}/release/gut${ext}`,
          ],
          depends_on: buildKey,
        }))
      } else if (platform === "macos") {
        // macOS: Build and sign
        pipeline.steps.push(command({
          key: buildKey,
          label: `Build (${arch})`,
          agents: {
            queue: "macos",
          },
          command: [
            `rustup target add ${arch}`,
            `cargo build --release --target ${arch}`,
            `buildkite-agent artifact upload target/${arch}/release/gut`,
          ],
          depends_on: "test",
        }))

        const signKey = `sign-${platform}-${arch}`
        buildStepKeys.push(signKey)

        pipeline.steps.push(command({
          key: signKey,
          label: `Sign (${arch})`,
          agents: {
            queue: "linux",
          },
          command: [
            "echo '--- Downloading unsigned binary'",
            `buildkite-agent artifact download target/${arch}/release/gut .`,
            "echo '--- Signing'",
            `divvun-actions run macos-sign target/${arch}/release/gut`,
            "echo '--- Uploading signed binary'",
            `mkdir -p signed/target/${arch}/release`,
            `mv target/${arch}/release/gut signed/target/${arch}/release/gut`,
            `buildkite-agent artifact upload signed/target/${arch}/release/gut`,
          ],
          depends_on: buildKey,
        }))
      } else {
        // Linux
        pipeline.steps.push(command({
          key: buildKey,
          label: `Build (${arch})`,
          agents: {
            queue: arch.includes("-musl") ? "alpine" : "linux",
          },
          command: [
            `rustup target add ${arch}`,
            `cargo build --release --target ${arch}`,
            `buildkite-agent artifact upload target/${arch}/release/gut`,
          ],
          depends_on: "test",
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
        }))
      }
    }
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
        depends_on: buildStepKeys,
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
  // macOS: download signed binaries
  await builder.downloadArtifacts(
    "signed/target/*-apple-darwin/release/gut",
    tempDir.path,
  )
  // Linux: download from regular path (no signing step)
  await builder.downloadArtifacts("target/*-linux-*/release/gut", tempDir.path)
  // Windows: download signed binaries
  await builder.downloadArtifacts(
    "signed/target/*-pc-windows-msvc/release/gut.exe",
    tempDir.path,
  )

  using archivePath = await makeTempDir({ prefix: "gut-" })

  const allArtifacts: string[] = []

  for (const target of ALL_TARGETS) {
    const ext = target.includes("windows") ? ".exe" : ""
    const archiveExt = target.includes("windows") ? "zip" : "tgz"
    const binaryName = `gut${ext}`
    const isSigned = target.includes("apple-darwin") ||
      target.includes("windows")

    // macOS and Windows binaries are under signed/ prefix, Linux is under target/
    const inputPath = path.join(
      tempDir.path,
      ...(isSigned ? ["signed", "target"] : ["target"]),
      target,
      "release",
      binaryName,
    )

    const outPath = path.join(
      archivePath.path,
      `gut-${target}-${builder.env.tag!}.${archiveExt}`,
    )

    if (!target.includes("windows")) {
      await Deno.chmod(inputPath, 0o755)
    }

    // Create staging directory with the binary inside
    const stagingDir = path.join(
      archivePath.path,
      `gut-${target}-${builder.env.tag!}`,
    )
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(inputPath, path.join(stagingDir, binaryName))

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
    allArtifacts,
    { latest: true },
  )
}
