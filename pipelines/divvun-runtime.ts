import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { Tar, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

type Config = {
  targets: string[]
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

async function config() {
  let unknown = builder.env.config

  if (unknown == null) {
    const data = await builder.metadata("divvun-runtime:config")
    if (data == null) {
      throw new Error("No config provided")
    }
    unknown = JSON.parse(data)
  }

  if (unknown instanceof Error) {
    throw unknown
  }

  if (unknown === null) {
    throw new Error("No config provided")
  }

  if (typeof unknown === "object") {
    if (
      !(Array.isArray(unknown.targets) &&
        unknown.targets.every((t) => typeof t === "string"))
    ) {
      throw new Error("Invalid or missing 'targets' array in config")
    }

    return unknown as Config
  }

  throw new Error("Invalid config provided")
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

export async function pipelineDivvunRuntime() {
  const cfg = await config()
  await builder.setMetadata("divvun-runtime:config", JSON.stringify(cfg))

  // Load version from Cargo.toml
  const cargoTomlText = await Deno.readTextFile("Cargo.toml")
  // Grab the version with a regex because nothing in js land works.
  const versionMatch = cargoTomlText.match(/version\s*=\s*"(.*?)"/)
  const version = versionMatch?.[1]

  if (typeof version !== "string") {
    throw new Error("Could not determine version from Cargo.toml")
  }

  const buildSteps: CommandStep[] = []

  for (const target of cfg.targets) {
    const artifactName = `divvun-runtime${
      target.includes("windows") ? ".exe" : ""
    }`
    const targetFile = `target/${target}/release/${artifactName}`

    if (target.includes("apple")) {
      // macOS targets: Split into build and sign steps
      buildSteps.push(command({
        label: `${target} - Build`,
        key: `cli-build-${target}`,
        command: [
          `./x build --target ${target}`,
          `mv ${targetFile} ./divvun-runtime-unsigned-${target}`,
          `buildkite-agent artifact upload divvun-runtime-unsigned-${target}`,
        ],
        agents: {
          queue: "macos",
        },
      }))

      buildSteps.push(command({
        label: `${target} - Sign`,
        command: [
          "echo '--- Downloading unsigned binary'",
          `buildkite-agent artifact download divvun-runtime-unsigned-${target} .`,
          "echo '--- Signing'",
          `divvun-actions run macos-sign ./divvun-runtime-unsigned-${target} '' ./playground/src-tauri/Entitlements.plist`,
          "echo '--- Uploading signed binary'",
          `mv ./divvun-runtime-unsigned-${target} ./divvun-runtime-${target}`,
          `buildkite-agent artifact upload divvun-runtime-${target}`,
        ],
        agents: {
          queue: "linux",
        },
        depends_on: `cli-build-${target}`,
      }))
    } else {
      // Non-macOS targets: Build and upload directly
      buildSteps.push(command({
        label: `build-${target}`,
        command: [
          `./x build --target ${target}`,
          `mv ${targetFile} ./${artifactName}-${target} && buildkite-agent artifact upload ${artifactName}-${target}`,
        ],
        agents: {
          queue: target.includes("-musl") ? "alpine" : os(target),
        },
      }))
    }
  }

  const uiBuildSteps: CommandStep[] = []

  for (const target of cfg.targets) {
    if (os(target) === "linux") {
      continue
    }

    // Step 1: Build on macOS and upload unsigned app
    uiBuildSteps.push(command({
      label: `Playground (${target}) - Build`,
      key: `playground-build-${target}`,
      command: [
        "echo '--- Building UI'",
        `./x build-ui --target ${target}`,
        `cp -r "./playground/src-tauri/target/${target}/release/bundle/macos/Divvun Runtime Playground.app" . 2>/dev/null || cp -r './playground/src-tauri/target/release/bundle/macos/Divvun Runtime Playground.app' .`,
        "echo '--- Updating version'",
        `/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${version}" './Divvun Runtime Playground.app/Contents/Info.plist'`,
        "echo '--- Zipping unsigned app'",
        "ditto -c -k --keepParent './Divvun Runtime Playground.app' divvun-rt-playground-unsigned.zip",
        "buildkite-agent artifact upload divvun-rt-playground-unsigned.zip",
      ],
      agents: { queue: "macos" },
    }))

    // Step 2: Sign on Linux and create final artifact
    uiBuildSteps.push(command({
      label: `Playground (${target}) - Sign`,
      command: [
        "echo '--- Downloading unsigned app'",
        "buildkite-agent artifact download divvun-rt-playground-unsigned.zip .",
        "echo '--- Unzipping'",
        "unzip -q divvun-rt-playground-unsigned.zip",
        "echo '--- Signing'",
        `divvun-actions run macos-sign './Divvun Runtime Playground.app' '' ./playground/src-tauri/Entitlements.plist`,
        "echo '--- Creating final archive'",
        `bsdtar --gzip --options gzip:compression-level=9 -cf divvun-rt-playground-${target} './Divvun Runtime Playground.app'`,
        `buildkite-agent artifact upload divvun-rt-playground-${target}`,
      ],
      agents: { queue: "linux" },
      depends_on: `playground-build-${target}`,
    }))
  }

  const pipeline: BuildkitePipeline = {
    steps: [
      {
        group: "Build",
        key: "build",
        steps: [...uiBuildSteps, ...buildSteps],
      },
    ],
  }

  if (builder.env.tag && builder.env.tag.match(/^v/)) {
    pipeline.steps.push(
      command({
        label: "Publish",
        command: "divvun-actions run divvun-runtime-publish",
        agents: {
          queue: "linux",
        },
        depends_on: "build",
      }),
    )
  }

  return pipeline
}

export async function runDivvunRuntimePublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  const cfg = await config()
  using tempDir = await makeTempDir()
  await Promise.all(
    cfg.targets.map((target) =>
      builder.downloadArtifacts(`divvun-runtime-${target}`, tempDir.path)
    ),
  )

  // Download signed playground artifacts for non-Linux targets
  const playgroundTargets = cfg.targets.filter((t) => os(t) !== "linux")
  await Promise.all(
    playgroundTargets.map((target) =>
      builder.downloadArtifacts(`divvun-rt-playground-${target}`, tempDir.path)
    ),
  )

  using archivePath = await makeTempDir({ prefix: "divvun-runtime-" })

  // Move playground artifacts to archive path with tag
  for (const target of playgroundTargets) {
    const artifactName = `divvun-rt-playground-${target}`
    const sourcePath = path.join(tempDir.path, artifactName)
    const destPath = path.join(
      archivePath.path,
      `${artifactName}_${builder.env.tag!}.tar.gz`,
    )
    await fs.move(sourcePath, destPath, { overwrite: true })
  }

  for (const target of cfg.targets) {
    const ext = target.includes("windows") ? "zip" : "tgz"
    const outPath = `${archivePath.path}/divvun-runtime-${target}-${builder.env
      .tag!}.${ext}`
    const inputPath = `${tempDir.path}/divvun-runtime-${target}${
      target.includes("windows") ? ".exe" : ""
    }`

    if (!target.includes("windows")) {
      await Deno.chmod(inputPath, 0o755)
    }

    const stagingDir = `divvun-runtime-${target}-${builder.env.tag!}`
    await Deno.mkdir(`divvun-runtime-${target}-${builder.env.tag!}`)
    await Deno.copyFile(
      inputPath,
      `${stagingDir}/divvun-runtime${target.includes("windows") ? ".exe" : ""}`,
    )

    if (target.includes("windows")) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }
  }

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(
    builder.env.tag!,
    [`${archivePath.path}/*`],
  )
}
