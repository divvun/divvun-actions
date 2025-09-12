import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export async function runLibpahkatIos() {
  const targets = ["aarch64-apple-ios", "aarch64-apple-ios-sim"]

  for (const target of targets) {
    const proc = new Deno.Command("cargo", {
      args: [
        "build",
        "--target",
        target,
        "--release",
        "--features",
        "prefix,ffi",
      ],
      cwd: "pahkat-client-core",
    }).spawn()

    const output = await proc.status

    if (!output.success) {
      throw new Error(
        `Failed to build libpahkat-ios: exit code ${output.code}`,
      )
    }
  }
}

export async function runLibpahkatAndroid() {
  const proc = new Deno.Command("cargo", {
    args: [
      "ndk",
      "build",
      "-o",
      "jniLibs",
      "--target",
      "armv7-linux-androideabi",
      "--target",
      "aarch64-linux-android",
      "--release",
      "--features",
      "prefix,ffi",
    ],
    cwd: "pahkat-client-core",
  }).spawn()

  const output = await proc.status

  if (!output.success) {
    throw new Error(
      `Failed to build libpahkat-android: exit code ${output.code}`,
    )
  }
}

export async function runLibpahkatPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  // const cfg = await config()
  // using tempDir = await makeTempDir()
  // await Promise.all(
  //   cfg.targets.map((target) =>
  //     builder.downloadArtifacts(`libpahkat-${target}`, tempDir.path)
  //   ),
  // )

  // using archivePath = await makeTempDir({ prefix: "divvun-runtime-" })

  // for (const target of cfg.targets) {
  //   const ext = target.includes("windows") ? "zip" : "tgz"
  //   const outPath = `${archivePath.path}/divvun-runtime-${target}-${builder.env
  //     .tag!}.${ext}`
  //   const inputPath = `${tempDir.path}/divvun-runtime-${target}${
  //     target.includes("windows") ? ".exe" : ""
  //   }`

  //   if (!target.includes("windows")) {
  //     await Deno.chmod(inputPath, 0o755)
  //   }

  //   const stagingDir = `divvun-runtime-${target}-${builder.env.tag!}`
  //   await Deno.mkdir(`divvun-runtime-${target}-${builder.env.tag!}`)
  //   await Deno.copyFile(
  //     inputPath,
  //     `${stagingDir}/divvun-runtime${target.includes("windows") ? ".exe" : ""}`,
  //   )

  //   if (target.includes("windows")) {
  //     await Zip.create([stagingDir], outPath)
  //   } else {
  //     await Tar.createFlatTgz([stagingDir], outPath)
  //   }
  // }

  // const gh = new GitHub(builder.env.repo)
  // await gh.createRelease(
  //   builder.env.tag!,
  //   [`${archivePath.path}/*`],
  // )
}

export default function pipelineLibpahkat() {
  const isReleaseTag = builder.env.tag?.startsWith("libpahkat/v") ?? false

  const pipeline: BuildkitePipeline = {
    steps: [
      {
        "group": "Build",
        "key": "build",
        "steps": [
          command({
            label: "Android",
            command: "divvun-actions run libpahkat-android",
          }),
          command({
            label: "iOS",
            command: "divvun-actions run libpahkat-ios",
            agents: { queue: "macos" },
          }),
        ],
      },
    ],
  }

  if (isReleaseTag) {
    pipeline.steps.push({
      label: "Publish",
      command: "divvun-actions run libpahkat-publish",
      agents: {
        queue: "linux",
      },
      depends_on: "build",
    })
  }

  return pipeline
}
