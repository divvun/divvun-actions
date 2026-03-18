import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "../../util/github.ts"
import logger from "../../util/log.ts"
import { Tar, Zip } from "../../util/shared.ts"
import { makeTempDir } from "../../util/temp.ts"

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
        "-p",
        "divvun-fst-ffi",
        "--lib",
        "--release",
        "-v",
      ],
    }
  }

  if (arch === "aarch64-unknown-linux-gnu") {
    return {
      cmd: "cross",
      args: [
        "build",
        "-p",
        "divvun-fst-ffi",
        "--lib",
        "--release",
        "--target",
        arch,
      ],
    }
  }

  return {
    cmd: "cargo",
    args: [
      "build",
      "--lib",
      "-p",
      "divvun-fst-ffi",
      "--release",
      "--target",
      arch,
    ],
  }
}

function buildBin(arch: string): { cmd: string; args: string[] } {
  const args = [
    "build",
    "-p",
    "divvunspell-cli",
    "--bin",
    "divvunspell",
    "--features",
    "accuracy",
    "--release",
    "--target",
    arch,
  ]
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

function createBinSignStep(
  platform: "windows" | "macos",
  arch: string,
  buildKey: string,
): CommandStep {
  const ext = platform === "windows" ? ".exe" : ""
  const binaryPath = `target/${arch}/release/divvunspell${ext}`
  const signedPath = `signed/${binaryPath}`

  const downloadPath = platform === "windows"
    ? `target\\${arch}\\release\\divvunspell${ext}`
    : binaryPath

  const signCommand = platform === "windows"
    ? `divvun-actions sign ${binaryPath}`
    : `divvun-actions run macos-sign ${binaryPath}`

  return command({
    key: `sign-${platform}-${arch}`,
    label: "Sign",
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

export function pipelineDivvunspell() {
  const steps: BuildkitePipeline["steps"] = []

  let isPublishLib = false
  let isPublishBin = false

  if (builder.env.tag?.startsWith("libdivvun-fst/v")) {
    isPublishLib = true
  } else if (builder.env.tag?.startsWith("divvunspell/v")) {
    isPublishBin = true
  }

  if (!isPublishLib) {
    const publishDependKeys: string[] = []

    for (const [os, archs] of Object.entries(binPlatforms)) {
      for (const arch of archs) {
        const { cmd, args } = buildBin(arch)
        const buildKey = `build-bin-${os}-${arch}`
        const isWindows = os === "windows"
        const ext = isWindows ? ".exe" : ""
        const binaryPath = `target/${arch}/release/divvunspell${ext}`

        const groupSteps: CommandStep[] = []

        groupSteps.push(command({
          key: buildKey,
          agents: { queue: os },
          label: "Build",
          command: [
            `${cmd} ${args.join(" ")}`,
            `buildkite-agent artifact upload ${binaryPath}`,
          ],
        }))

        if (isPublishBin && (os === "macos" || os === "windows")) {
          const signKey = `sign-${os}-${arch}`
          publishDependKeys.push(signKey)
          groupSteps.push(
            createBinSignStep(os as "macos" | "windows", arch, buildKey),
          )
        } else {
          publishDependKeys.push(buildKey)
        }

        steps.push({
          group: `${os} ${arch}`,
          steps: groupSteps,
        })
      }
    }

    if (isPublishBin) {
      steps.push(command({
        label: "Publish",
        command: "divvun-actions run divvunspell-publish",
        agents: { queue: "linux" },
        depends_on: publishDependKeys,
      }))
    }
  }

  if (!isPublishBin) {
    const libSteps: CommandStep[] = []

    for (const [os, archs] of Object.entries(libPlatforms)) {
      for (const arch of archs) {
        const { cmd, args } = buildLib(arch)

        if (os === "windows") {
          libSteps.push(command({
            agents: { queue: os },
            label: arch,
            command: [
              `${cmd} ${args.join(" ")}`,
              `mv target/${arch}/release/divvun_fst.dll divvun_fst-${arch}.dll`,
              `buildkite-agent artifact upload divvun_fst-${arch}.dll`,
            ],
          }))
        } else {
          const ext = os === "linux" ? "so" : "dylib"
          const libName = `libdivvun_fst-${arch}.${ext}`

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
            `mv target/${arch}/release/libdivvun_fst.${ext} ${libName}`,
            stripCmd ? `${stripCmd} ${libName}` : undefined,
            `buildkite-agent artifact upload ${libName}`,
          ].filter((c) => c !== undefined) as string[]

          libSteps.push(command({
            agents: { queue: os },
            label: arch,
            command: commands,
          }))
        }
      }
    }

    if (libSteps.length > 0) {
      steps.push({
        group: "Build Libraries",
        key: "build-libraries",
        steps: libSteps,
      })
    }

    if (isPublishLib) {
      steps.push(command({
        label: "Publish",
        command: "divvun-actions run libdivvun-fst-publish",
        agents: { queue: "linux" },
        depends_on: "build-libraries",
      }))
    }
  }

  return { steps }
}

export async function runLibdivvunFstPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish libdivvun-fst")
  }

  if (!builder.env.tag.startsWith("libdivvun-fst/v")) {
    throw new Error(
      `Tag ${builder.env.tag} does not start with libdivvun-fst/v, cannot publish libdivvun-fst`,
    )
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish libdivvun-fst")
  }

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(`libdivvun_fst-*`, tempDir.path)
  await builder.downloadArtifacts(`divvun_fst-*`, tempDir.path)

  using archivePath = await makeTempDir({ prefix: "libdivvun-fst-" })
  const [_tag, version] = builder.env.tag.split("/")

  const artifacts = []

  for (const [os, targets] of Object.entries(libPlatforms)) {
    for (const target of targets) {
      const libExt = os === "linux" ? "so" : os === "macos" ? "dylib" : "dll"
      const libFileName = os === "windows"
        ? `divvun_fst.dll`
        : `libdivvun_fst.${libExt}`

      const artifactName = `${
        os === "windows" ? "" : "lib"
      }divvun_fst-${target}.${libExt}`
      const inputPath = `${tempDir.path}/${artifactName}`

      const archiveFilePath = tempDir.path + "/" + target
      const libPath = archiveFilePath + "/lib"
      await Deno.mkdir(libPath, { recursive: true })
      await Deno.rename(inputPath, `${libPath}/${libFileName}`)

      const ext = os === "windows" ? "zip" : "tgz"
      const outPath =
        `${archivePath.path}/libdivvun-fst-${target}-${version}.${ext}`

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

  // Check if we have Android artifacts (they will be in tgz packages)
  const androidArtifactStatus: string[] = []
  const androidPackagePaths: string[] = []
  const hasAndroidArtifacts = androidArchs.every((arch) => {
    // Look for the packaged tgz instead of raw .so files
    const packageName = `libdivvun-fst-${arch}-${version}.tgz`
    const packagePath = `${archivePath.path}/${packageName}`
    try {
      const stat = Deno.statSync(packagePath)
      logger.info(`✓ Found ${packageName} (${stat.size} bytes)`)
      androidArtifactStatus.push(`${arch}: found`)
      androidPackagePaths.push(packagePath)
      return true
    } catch {
      logger.info(`✗ Missing ${packageName}`)
      androidArtifactStatus.push(`${arch}: missing`)
      return false
    }
  })

  logger.info(`Android artifact check: ${androidArtifactStatus.join(", ")}`)

  if (hasAndroidArtifacts) {
    logger.info("Creating Android jniLibs package...")

    // Create jniLibs directory structure
    await Deno.mkdir(`${jniLibsDir}/arm64-v8a`, { recursive: true })
    await Deno.mkdir(`${jniLibsDir}/armeabi-v7a`, { recursive: true })

    // Extract libraries from existing tgz packages
    using tempExtractDir = await makeTempDir({ prefix: "android-extract-" })

    for (let i = 0; i < androidArchs.length; i++) {
      const arch = androidArchs[i]
      const packagePath = androidPackagePaths[i]

      logger.info(`Extracting ${packagePath}`)
      await Tar.extractTar(packagePath, tempExtractDir.path)

      const libPath = `${tempExtractDir.path}/lib/libdivvun_fst.so`
      const targetDir = arch === "aarch64-linux-android"
        ? "arm64-v8a"
        : "armeabi-v7a"
      const targetPath = `${jniLibsDir}/${targetDir}/libdivvun_fst.so`

      logger.info(`Copying extracted lib: ${libPath} -> ${targetPath}`)
      await Deno.copyFile(libPath, targetPath)

      // Verify copied file
      const stat = Deno.statSync(targetPath)
      logger.info(`Copied ${targetDir} lib: ${stat.size} bytes`)

      // Clean up extracted files for next iteration
      await Deno.remove(`${tempExtractDir.path}/lib`, { recursive: true })
    }

    // Create Android package tgz
    const androidPackagePath =
      `${archivePath.path}/libdivvun-fst-android-jniLibs-${version}.tgz`
    logger.info(`Creating Android package: ${androidPackagePath}`)
    await Tar.createFlatTgz([jniLibsDir], androidPackagePath)

    // Verify package was created
    const packageStat = Deno.statSync(androidPackagePath)
    logger.info(`Android package created: ${packageStat.size} bytes`)

    artifacts.push(androidPackagePath)
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
      logger.error(
        `  ${index + 1}. ${fileName} (ERROR: ${
          e instanceof Error ? e.message : String(e)
        })`,
      )
    }
  })

  logger.info("Creating GitHub release...")
  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(builder.env.tag, artifacts)
  logger.info("GitHub release completed")
}

export async function runDivvunspellPublish() {
  if (!builder.env.tag) {
    throw new Error("No tag found, cannot publish divvunspell")
  }

  if (!builder.env.tag.startsWith("divvunspell/v")) {
    throw new Error(
      `Tag ${builder.env.tag} does not start with divvunspell/v, cannot publish divvunspell`,
    )
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish divvunspell")
  }

  const [_prefix, version] = builder.env.tag.split("/")

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(
    `signed/target/*-apple-darwin/release/divvunspell`,
    tempDir.path,
  )
  await builder.downloadArtifacts(
    `signed/target/*-pc-windows-msvc/release/divvunspell.exe`,
    tempDir.path,
  )
  await builder.downloadArtifacts(
    `target/*-linux-*/release/divvunspell`,
    tempDir.path,
  )

  using archivePath = await makeTempDir({ prefix: "divvunspell-" })
  const artifacts: string[] = []

  for (const [os, archs] of Object.entries(binPlatforms)) {
    for (const arch of archs) {
      const isWindows = os === "windows"
      const isSigned = os === "macos" || isWindows
      const ext = isWindows ? "zip" : "tgz"
      const binaryExt = isWindows ? ".exe" : ""

      const inputPath = path.join(
        tempDir.path,
        ...(isSigned ? ["signed", "target"] : ["target"]),
        arch,
        "release",
        `divvunspell${binaryExt}`,
      )

      if (!isWindows) {
        await Deno.chmod(inputPath, 0o755)
      }

      const stagingName = `divvunspell-${arch}-${version}`
      const stagingDir = path.join(archivePath.path, stagingName)
      await Deno.mkdir(stagingDir)
      await Deno.copyFile(
        inputPath,
        path.join(stagingDir, `divvunspell${binaryExt}`),
      )

      const outPath = path.join(archivePath.path, `${stagingName}.${ext}`)
      if (isWindows) {
        await Zip.create([stagingDir], outPath)
      } else {
        await Tar.createFlatTgz([stagingDir], outPath)
      }

      artifacts.push(outPath)
    }
  }

  logger.info(`Creating GitHub release for ${builder.env.tag}...`)
  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(builder.env.tag, artifacts, { latest: true })
  logger.info("GitHub release completed")
}
