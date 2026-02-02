import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { Tar } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import { createSignedChecksums } from "~/util/hash.ts"

const TARGETS = [
  "x86_64-unknown-linux-musl",
  "x86_64-unknown-linux-gnu",
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

export function pipelineDivvunWorkerTts(): BuildkitePipeline {
  const buildSteps: CommandStep[] = []

  for (const target of TARGETS) {
    const targetFile = path.join(
      "target",
      target,
      "release",
      "divvun-worker-tts",
    )
    const queue = target.includes("-musl") ? "alpine" : "linux"

    buildSteps.push(
      command({
        label: `build-${target}`,
        command: [
          `./x build --target ${target}`,
          `mv ${targetFile} ./divvun-worker-tts-${target}`,
          `buildkite-agent artifact upload divvun-worker-tts-${target}`,
        ],
        agents: { queue },
      }),
    )
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

  // Add publish step for version tags
  if (builder.env.tag?.match(/^v/)) {
    pipeline.steps.push(
      command({
        label: "Publish",
        command: "divvun-actions run divvun-worker-tts-publish",
        agents: { queue: "linux" },
        depends_on: "build",
      }),
    )
  }

  return pipeline
}

export async function runDivvunWorkerTtsPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish")
  }
  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  using tempDir = await makeTempDir()

  // Download all artifacts
  await Promise.all(
    TARGETS.map((target) =>
      builder.downloadArtifacts(`divvun-worker-tts-${target}`, tempDir.path)
    ),
  )

  using archivePath = await makeTempDir({ prefix: "divvun-worker-tts-" })
  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const outPath = path.join(
      archivePath.path,
      `divvun-worker-tts-${target}-${builder.env.tag}.tgz`,
    )
    const inputPath = path.join(tempDir.path, `divvun-worker-tts-${target}`)

    await Deno.chmod(inputPath, 0o755)

    const stagingDir = `divvun-worker-tts-${target}-${builder.env.tag}`
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(inputPath, path.join(stagingDir, "divvun-worker-tts"))

    await Tar.createFlatTgz([stagingDir], outPath)
    allArtifacts.push(outPath)
  }

  // Create signed checksums
  const { checksumFile, signatureFile } = await createSignedChecksums(
    allArtifacts,
    await builder.secrets(),
  )

  const checksumDest = path.join(archivePath.path, checksumFile)
  const signatureDest = path.join(archivePath.path, signatureFile)
  await fs.move(checksumFile, checksumDest, { overwrite: true })
  await fs.move(signatureFile, signatureDest, { overwrite: true })

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(builder.env.tag, [`${archivePath.path}/*`], {
    latest: true,
  })

  // Build and push Docker images
  const version = builder.env.tag.replace(/^v/, "")

  // Build and push GNU image
  const gnuBinaryPath = path.join(
    tempDir.path,
    "divvun-worker-tts-x86_64-unknown-linux-gnu",
  )
  await Deno.copyFile(gnuBinaryPath, "./divvun-worker-tts")
  await Deno.chmod("./divvun-worker-tts", 0o755)

  await builder.exec("docker", [
    "build",
    "-f",
    "Dockerfile.gnu",
    "-t",
    `ghcr.io/divvun/divvun-worker-tts:${version}`,
    "-t",
    "ghcr.io/divvun/divvun-worker-tts:latest",
    ".",
  ])
  await builder.exec("docker", [
    "push",
    `ghcr.io/divvun/divvun-worker-tts:${version}`,
  ])
  await builder.exec("docker", [
    "push",
    "ghcr.io/divvun/divvun-worker-tts:latest",
  ])

  // Build and push musl image
  const muslBinaryPath = path.join(
    tempDir.path,
    "divvun-worker-tts-x86_64-unknown-linux-musl",
  )
  await Deno.copyFile(muslBinaryPath, "./divvun-worker-tts")
  await Deno.chmod("./divvun-worker-tts", 0o755)

  await builder.exec("docker", [
    "build",
    "-f",
    "Dockerfile.musl",
    "-t",
    `ghcr.io/divvun/divvun-worker-tts:${version}-musl`,
    "-t",
    "ghcr.io/divvun/divvun-worker-tts:latest-musl",
    ".",
  ])
  await builder.exec("docker", [
    "push",
    `ghcr.io/divvun/divvun-worker-tts:${version}-musl`,
  ])
  await builder.exec("docker", [
    "push",
    "ghcr.io/divvun/divvun-worker-tts:latest-musl",
  ])
}
