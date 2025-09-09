import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "../util/log.ts"
import { Tar, Zip } from "../util/shared.ts"
import { makeTempDir } from "../util/temp.ts"

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

// function interpolate(template: string, vars: Record<string, string>): string {
//     return template.replace(/{\s*(\w+)\s*}/g, (_, key) => {
//         if (key in vars) {
//             return vars[key]
//         }
//         throw new Error(`Unknown variable: ${key}`)
//     })
// }

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

  const buildSteps: CommandStep[] = []

  for (const target of cfg.targets) {
    const artifactName = `divvun-runtime${
      target.includes("windows") ? ".exe" : ""
    }`
    const targetFile = `target/${target}/release/${artifactName}`
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

  const pipeline: BuildkitePipeline = {
    steps: [
      {
        group: "Build",
        key: "build",
        steps: buildSteps,
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

  using archivePath = await makeTempDir({ prefix: "divvun-runtime-" })

  for (const target of cfg.targets) {
    const ext = target.includes("windows") ? "zip" : "tgz"
    const outPath = `${archivePath.path}/divvun-runtime-${target}-${builder.env
      .tag!}.${ext}`
    const inputPath = `${tempDir.path}/divvun-runtime${
      target.includes("windows") ? ".exe" : ""
    }`

    if (!target.includes("windows")) {
      await Deno.chmod(inputPath, 0o755)
    }

    if (target.includes("windows")) {
      await Zip.create([inputPath], outPath)
    } else {
      await Tar.createFlatTgz([inputPath], outPath)
    }
  }

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(
    builder.env.tag!,
    [`${archivePath.path}/*`],
  )
}

class GitHub {
  #repo: string

  constructor(repo: string) {
    this.#repo = repo
  }

  async createRelease(
    tag: string,
    artifacts: string[],
    draft = false,
    prerelease = false,
  ) {
    const args = [
      "release",
      "create",
      tag,
      "--verify-tag",
      "--generate-notes",
      "--repo",
      this.#repo,
      ...artifacts,
    ]

    if (draft) {
      args.push("--draft")
    }

    if (prerelease) {
      args.push("--prerelease")
    }

    logger.info(
      `Creating GitHub release: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )
    const proc = new Deno.Command("gh", {
      args,
    }).spawn()

    const { code } = await proc.output()
    if (code !== 0) {
      throw new Error(`Failed to create GitHub release: exit code ${code}`)
    }
  }
}
