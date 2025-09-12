import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { Tar } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

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
      "-o",
      "jniLibs",
      "--target",
      "armv7-linux-androideabi",
      "--target",
      "aarch64-linux-android",
      "build",
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

  // Strip libpahkat_client.so files and remove non-libpahkat .so files
  const jniLibsPath = "pahkat-client-core/jniLibs"
  const ndkHome = Deno.env.get("ANDROID_NDK_HOME")

  if (!ndkHome) {
    throw new Error("ANDROID_NDK_HOME not set")
  }

  const stripCmd =
    `${ndkHome}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip`

  for await (const archDir of Deno.readDir(jniLibsPath)) {
    if (archDir.isDirectory) {
      const archPath = `${jniLibsPath}/${archDir.name}`

      for await (const file of Deno.readDir(archPath)) {
        if (file.name.endsWith(".so")) {
          const filePath = `${archPath}/${file.name}`

          if (file.name === "libpahkat_client.so") {
            // Strip the libpahkat_client.so file
            await builder.exec(stripCmd, [filePath])
            console.log(`Stripped ${filePath}`)
          } else if (!file.name.startsWith("libpahkat")) {
            // Remove non-libpahkat .so files
            await Deno.remove(filePath)
            console.log(`Removed ${filePath}`)
          }
        }
      }
    }
  }

  // Create tarball of jniLibs directory
  const tarPath = "libpahkat-android.tar.gz"
  await Tar.createFlatTgz([jniLibsPath], tarPath)
  console.log(`Created tarball: ${tarPath}`)

  // Upload tarball as artifact
  await builder.uploadArtifacts(tarPath)
}

export async function runLibpahkatPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  // const cfg = await config()
  using tempDir = await makeTempDir()
  await Promise.all([
    // builder.downloadArtifacts(`libpahkat-ios`, tempDir.path),
    builder.downloadArtifacts(`libpahkat-android.tar.gz`, tempDir.path),
  ])

  using archivePath = await makeTempDir({ prefix: "libpahkat-" })

  const [_tag, version] = builder.env.tag.split("/")
  await Deno.rename(
    `${tempDir.path}/libpahkat-android.tar.gz`,
    `${archivePath.path}/libpahkat-android-${version}.tgz`,
  )

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(
    builder.env.tag!,
    [`${archivePath.path}/*`],
  )
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
