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
    // const uiTargetFile =
    const step = command({
      label: `${target}`,
      command: [
        `just build ${target}`,
        `mv ${targetFile} ./${artifactName}-${target} && buildkite-agent artifact upload ${artifactName}-${target}`,
      ],
      agents: {
        queue: os(target),
      },
    })

    buildSteps.push(step)
  }

  const uiBuildSteps: CommandStep[] = []

  for (const target of cfg.targets) {
    if (os(target) === "linux") {
      continue
    }

    uiBuildSteps.push(command({
      label: "Playground (macOS)",
      command: [
        "just build-ui",
        "cp -r ./playground/src-tauri/target/release/bundle/macos/Divvun\ Runtime\ Playground.app .",
        `divvun-actions macos-sign Divvun\\ Runtime\\ Playground.app ${version}`,
        `ditto -c -k --keepParent Divvun\\ Runtime\\ Playground.app out.zip`,
        `mv out.zip divvun-rt-playground-${target}`,
        `buildkite-agent artifact upload divvun-rt-playground-${target}`,
      ],
    }))
  }

  const pipeline: BuildkitePipeline = {
    steps: [
      {
        group: "Build",
        key: "build",
        steps: [...buildSteps, ...uiBuildSteps],
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

  await builder.downloadArtifacts("divvun-rt-playground-*", tempDir.path)

  using archivePath = await makeTempDir({ prefix: "divvun-runtime-" })

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
