import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "../../util/github.ts"
import { Tar, Zip } from "../../util/shared.ts"
import { makeTempDir } from "../../util/temp.ts"
import logger from "../../util/log.ts"

const binPlatforms = {
  macos: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  linux: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

const libPlatforms = {
  macos: [
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
  ],
  linux: [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "x86_64-linux-android",
  ],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

function buildLib(arch: string): { cmd: string; args: string[] } {
  if (arch.includes("android")) {
    return {
      cmd: "cargo",
      args: [
        "ndk",
        "--target",
        arch,
        "build",
        "--lib",
        "--release",
        "--features",
        "internal_ffi",
        "-v",
      ],
    }
  }

  if (arch === "aarch64-unknown-linux-gnu") {
    return {
      cmd: "cross",
      args: [
        "build",
        "--lib",
        "--release",
        "--target",
        arch,
        "--features",
        "internal_ffi",
      ],
    }
  }

  return {
    cmd: "cargo",
    args: [
      "build",
      "--lib",
      "--release",
      "--target",
      arch,
      "--features",
      "internal_ffi",
    ],
  }
}

function buildBin(arch: string): { cmd: string; args: string[] } {
  const args = ["build", "--bin", "divvunspell", "--release", "--target", arch]
  const cmd = arch === "aarch64-unknown-linux-gnu" ? "cross" : "cargo"
  return { cmd, args }
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

export function pipelineDivvunspell() {
  const binSteps = []
  const libSteps = []

  let isPublishLib = false

  if (builder.env.tag?.startsWith("libdivvunspell/v")) {
    isPublishLib = true
  }

  if (!isPublishLib) {
    for (const [os, archs] of Object.entries(binPlatforms)) {
      for (const arch of archs) {
        const { cmd, args } = buildBin(arch)

        if (os === "windows") {
          binSteps.push(command({
            agents: {
              queue: os,
            },
            label: arch,
            command: [
              `${cmd} ${args.join(" ")}`,
              `mv target/${arch}/release/divvunspell.exe divvunspell-${arch}.exe`,
              `buildkite-agent artifact upload divvunspell-${arch}.exe`,
            ],
          }))
        } else {
          binSteps.push(command({
            agents: {
              queue: os,
            },
            label: arch,
            command: [
              `${cmd} ${args.join(" ")}`,
              `mv target/${arch}/release/divvunspell divvunspell-${arch}`,
              `buildkite-agent artifact upload divvunspell-${arch}`,
            ],
          }))
        }
      }
    }
  }

  for (const [os, archs] of Object.entries(libPlatforms)) {
    for (const arch of archs) {
      const { cmd, args } = buildLib(arch)

      if (os === "windows") {
        libSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: [
            `${cmd} ${args.join(" ")}`,
            `mv target/${arch}/release/divvunspell.dll divvunspell-${arch}.dll`,
            `buildkite-agent artifact upload divvunspell-${arch}.dll`,
          ],
        }))
      } else {
        const ext = os === "linux" ? "so" : "dylib"
        const libName = `libdivvunspell-${arch}.${ext}`

        let stripCmd
        if (arch.includes("android")) {
          const ndkHome = Deno.env.get("ANDROID_NDK_HOME")

          if (!ndkHome) {
            throw new Error("ANDROID_NDK_HOME not set")
          }

          stripCmd =
            `${ndkHome}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip`
        }

        const commands = [
          `${cmd} ${args.join(" ")}`,
          `mv target/${arch}/release/libdivvunspell.${ext} ${libName}`,
          stripCmd ? `${stripCmd} ${libName}` : undefined,
          `buildkite-agent artifact upload ${libName}`,
        ].filter((c) => c !== undefined) as string[]

        libSteps.push(command({
          agents: {
            queue: os,
          },
          label: arch,
          command: commands,
        }))
      }
    }
  }

  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  if (binSteps.length > 0) {
    pipeline.steps.push({
      group: "Build Binaries",
      key: "build-binaries",
      steps: binSteps,
    })
  }

  pipeline.steps.push({
    group: "Build Libraries",
    key: "build-libraries",
    steps: libSteps,
  })

  if (isPublishLib) {
    pipeline.steps.push(command({
      label: "Publish",
      command: "divvun-actions run libdivvunspell-publish",
      agents: {
        queue: "linux",
      },
      depends_on: "build-libraries",
    }))
  }

  return pipeline
}

export async function runLibdivvunspellPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish libdivvunspell")
  }

  if (!builder.env.tag.startsWith("libdivvunspell/v")) {
    throw new Error(
      `Tag ${builder.env.tag} does not start with libdivvunspell/v, cannot publish libdivvunspell`,
    )
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish libdivvunspell")
  }

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(`libdivvunspell-*`, tempDir.path)
  await builder.downloadArtifacts(`divvunspell-*`, tempDir.path)

  using archivePath = await makeTempDir({ prefix: "libdivvunspell-" })
  const [_tag, version] = builder.env.tag.split("/")

  const artifacts = []

  for (const [os, targets] of Object.entries(libPlatforms)) {
    for (const target of targets) {
      const libExt = os === "linux" ? "so" : os === "macos" ? "dylib" : "dll"
      const libFileName = os === "windows"
        ? `divvunspell.dll`
        : `libdivvunspell.${libExt}`

      const artifactName = `${
        os === "windows" ? "" : "lib"
      }divvunspell-${target}.${libExt}`
      const inputPath = `${tempDir.path}/${artifactName}`

      const archiveFilePath = tempDir.path + "/" + target
      const libPath = archiveFilePath + "/lib"
      await Deno.mkdir(libPath, { recursive: true })
      await Deno.rename(inputPath, `${libPath}/${libFileName}`)

      const ext = os === "windows" ? "zip" : "tgz"
      const outPath =
        `${archivePath.path}/libdivvunspell-${target}-${version}.${ext}`

      if (ext === "zip") {
        await Zip.create([libPath], outPath)
      } else {
        await Tar.createFlatTgz([libPath], outPath)
      }

      artifacts.push(outPath)
    }
  }

  // Create Android package with jniLibs structure
  logger.info("Starting Android jniLibs package creation...")
  const androidArchs = ["aarch64-linux-android", "armv7-linux-androideabi"]
  const androidPackageDir = tempDir.path + "/android-package"
  const jniLibsDir = androidPackageDir + "/jniLibs"

  logger.debug(`Looking for Android artifacts in: ${tempDir.path}`)

  // List all files in temp directory for debugging
  try {
    const tempFiles = []
    for await (const entry of Deno.readDir(tempDir.path)) {
      tempFiles.push(entry.name)
    }
    logger.debug(`Available artifacts: ${tempFiles.join(", ")}`)
  } catch (e) {
    logger.error(`Error listing temp directory: ${e.message}`)
  }

  // Check if we have Android artifacts (they will be in tgz packages)
  const androidArtifactStatus: string[] = []
  const androidPackagePaths: string[] = []
  const hasAndroidArtifacts = androidArchs.every((arch) => {
    // Look for the packaged tgz instead of raw .so files
    const packageName = `libdivvunspell-${arch}-${version}.tgz`
    const packagePath = `${archivePath.path}/${packageName}`
    try {
      const stat = Deno.statSync(packagePath)
      logger.debug(`✓ Found ${packageName} (${stat.size} bytes)`)
      androidArtifactStatus.push(`${arch}: found`)
      androidPackagePaths.push(packagePath)
      return true
    } catch {
      logger.debug(`✗ Missing ${packageName}`)
      androidArtifactStatus.push(`${arch}: missing`)
      return false
    }
  })

  logger.info(`Android artifact check: ${androidArtifactStatus.join(", ")}`)
  logger.debug(`hasAndroidArtifacts: ${hasAndroidArtifacts}`)

  if (hasAndroidArtifacts) {
    logger.info("Creating Android jniLibs package...")

    // Create jniLibs directory structure
    logger.debug(`Creating directory: ${jniLibsDir}/arm64-v8a`)
    await Deno.mkdir(`${jniLibsDir}/arm64-v8a`, { recursive: true })
    logger.debug(`Creating directory: ${jniLibsDir}/armeabi-v7a`)
    await Deno.mkdir(`${jniLibsDir}/armeabi-v7a`, { recursive: true })

    // Extract libraries from existing tgz packages
    using tempExtractDir = await makeTempDir({ prefix: "android-extract-" })

    for (let i = 0; i < androidArchs.length; i++) {
      const arch = androidArchs[i]
      const packagePath = androidPackagePaths[i]

      logger.debug(`Extracting ${packagePath}`)
      await Tar.extractTgz(packagePath, tempExtractDir.path)

      const libPath = `${tempExtractDir.path}/lib/libdivvunspell.so`
      const targetDir = arch === "aarch64-linux-android" ? "arm64-v8a" : "armeabi-v7a"
      const targetPath = `${jniLibsDir}/${targetDir}/libdivvunspell.so`

      logger.debug(`Copying extracted lib: ${libPath} -> ${targetPath}`)
      await Deno.copyFile(libPath, targetPath)

      // Verify copied file
      const stat = Deno.statSync(targetPath)
      logger.debug(`Copied ${targetDir} lib: ${stat.size} bytes`)

      // Clean up extracted files for next iteration
      await Deno.remove(`${tempExtractDir.path}/lib`, { recursive: true })
    }

    // Create Android package tgz
    const androidPackagePath =
      `${archivePath.path}/libdivvunspell-android-jniLibs-${version}.tgz`
    logger.info(`Creating Android package: ${androidPackagePath}`)
    await Tar.createFlatTgz([jniLibsDir], androidPackagePath)

    // Verify package was created
    const packageStat = Deno.statSync(androidPackagePath)
    logger.info(`Android package created: ${packageStat.size} bytes`)

    artifacts.push(androidPackagePath)
    logger.info(
      `Added Android package to artifacts list. Total artifacts: ${artifacts.length}`,
    )
  } else {
    logger.info(
      "Skipping Android jniLibs package creation - missing required artifacts",
    )
  }

  logger.info(`Final artifacts list (${artifacts.length} total):`)
  artifacts.forEach((artifact, index) => {
    const fileName = artifact.split("/").pop()
    try {
      const stat = Deno.statSync(artifact)
      logger.info(`  ${index + 1}. ${fileName} (${stat.size} bytes)`)
    } catch (e) {
      logger.error(`  ${index + 1}. ${fileName} (ERROR: ${e.message})`)
    }
  })

  logger.info("Creating GitHub release...")
  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(builder.env.tag, artifacts, false, false)
  logger.info("GitHub release completed")
}
