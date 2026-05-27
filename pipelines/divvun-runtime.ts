import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { Tar, versionAsDev, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import { createSignedChecksums } from "~/util/hash.ts"

// Feature flags. Flip back to true when these flows are ready.
const PLAYGROUND_ENABLED = false
const MUSL_ENABLED = false

function isMuslEnabled(t: string): boolean {
  return MUSL_ENABLED || !t.includes("-musl")
}

// Main branch builds all targets for testing
const MAIN_TARGETS = [
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
  "x86_64-unknown-linux-gnu",
  "aarch64-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-apple-ios",
]

// CLI release targets
const CLI_RELEASE_TARGETS = [
  // "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
  "aarch64-apple-darwin",
]

// Library release targets. Each artifact contains both the cdylib
// (.dylib/.so/.dll) and the staticlib (.a/.lib) for the target — consumers
// pick whichever they need.
const LIB_RELEASE_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
]

// Playground release targets (just Apple Darwin for now)
const PLAYGROUND_RELEASE_TARGETS = [
  "aarch64-apple-darwin",
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

export async function pipelineDivvunRuntime() {
  // Use release targets if building a tag, otherwise main targets
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"
  const cliTargets = (isRelease ? CLI_RELEASE_TARGETS : MAIN_TARGETS).filter(
    isMuslEnabled,
  )
  const playgroundTargets = !PLAYGROUND_ENABLED
    ? []
    : (isRelease ? PLAYGROUND_RELEASE_TARGETS : MAIN_TARGETS).filter(
      isMuslEnabled,
    )

  // Load version from Cargo.toml
  const cargoTomlText = await Deno.readTextFile("Cargo.toml")
  // Grab the version with a regex because nothing in js land works.
  const versionMatch = cargoTomlText.match(/version\s*=\s*"(.*?)"/)
  const version = versionMatch?.[1]

  if (typeof version !== "string") {
    throw new Error("Could not determine version from Cargo.toml")
  }

  const buildSteps: CommandStep[] = []

  for (const target of cliTargets) {
    const artifactName = `divvun-runtime${
      target.includes("windows") ? ".exe" : ""
    }`
    const targetFile = path.join("target", target, "release", artifactName)

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
    } else if (os(target) === "windows") {
      // Windows targets: Build and upload directly
      const llvmArch = target.includes("aarch64") ? "ARM64" : "x64"
      buildSteps.push(command({
        label: `build-${target}`,
        command: [
          `$$env:PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\Llvm\\${llvmArch}\\bin;C:\\MSYS2\\usr\\bin;" + $$env:PATH; .\\x.ps1 build --target ${target}`,
          `mv ${targetFile} .\\${artifactName}-${target}`,
          `buildkite-agent artifact upload ${artifactName}-${target}`,
        ],
        agents: {
          queue: "windows",
        },
      }))
    } else {
      // Linux targets: Build and upload directly
      buildSteps.push(command({
        label: `build-${target}`,
        command: [
          `./x build --target ${target}`,
          `mv ${targetFile} ./${artifactName}-${target}`,
          `buildkite-agent artifact upload ${artifactName}-${target}`,
        ],
        agents: {
          queue: target.includes("-musl") ? "alpine" : "linux",
        },
      }))
    }
  }

  // Library builds — always run for all five lib targets so failures are
  // surfaced on every build. Each archive lays out lib/ (cdylib + staticlib)
  // and include/ (headers) so consumers can drop the contents straight into a
  // sysroot-style prefix.
  const libBuildSteps: CommandStep[] = []

  for (const target of LIB_RELEASE_TARGETS) {
    const artifactName = `libdivvun_runtime-${target}.tar.xz`
    const stageDir = `libdivvun_runtime-${target}`

    if (target.includes("apple")) {
      libBuildSteps.push(command({
        label: `lib-build-${target}`,
        key: `lib-build-${target}`,
        command: [
          `./x build-lib --target ${target}`,
          `mkdir -p ${stageDir}/lib ${stageDir}/include`,
          `cp target/${target}/release/libdivvun_runtime.dylib ${stageDir}/lib/`,
          `cp target/${target}/release/libdivvun_runtime.a ${stageDir}/lib/`,
          `cp target/${target}/release/divvun_runtime.h ${stageDir}/include/`,
          `tar -cJf ${artifactName} ${stageDir}`,
          `buildkite-agent artifact upload ${artifactName}`,
        ],
        agents: { queue: "macos" },
      }))
    } else if (os(target) === "windows") {
      const llvmArch = target.includes("aarch64") ? "ARM64" : "x64"
      libBuildSteps.push(command({
        label: `lib-build-${target}`,
        key: `lib-build-${target}`,
        command: [
          `$$env:PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\Llvm\\${llvmArch}\\bin;C:\\MSYS2\\usr\\bin;" + $$env:PATH; .\\x.ps1 build-lib --target ${target}`,
          `New-Item -ItemType Directory -Force -Path ${stageDir}/lib | Out-Null`,
          `New-Item -ItemType Directory -Force -Path ${stageDir}/include | Out-Null`,
          `Copy-Item target/${target}/release/divvun_runtime.dll ${stageDir}/lib/`,
          `Copy-Item target/${target}/release/divvun_runtime*.lib ${stageDir}/lib/`,
          `Copy-Item target/${target}/release/divvun_runtime.h ${stageDir}/include/`,
          `bsdtar -cJf ${artifactName} ${stageDir}`,
          `buildkite-agent artifact upload ${artifactName}`,
        ],
        agents: { queue: "windows" },
      }))
    } else {
      libBuildSteps.push(command({
        label: `lib-build-${target}`,
        key: `lib-build-${target}`,
        command: [
          `./x build-lib --target ${target}`,
          `mkdir -p ${stageDir}/lib ${stageDir}/include`,
          `cp target/${target}/release/libdivvun_runtime.so ${stageDir}/lib/`,
          `cp target/${target}/release/libdivvun_runtime.a ${stageDir}/lib/`,
          `cp target/${target}/release/divvun_runtime.h ${stageDir}/include/`,
          `tar -cJf ${artifactName} ${stageDir}`,
          `buildkite-agent artifact upload ${artifactName}`,
        ],
        agents: { queue: "linux" },
      }))
    }
  }

  const uiBuildSteps: CommandStep[] = []

  for (const target of playgroundTargets) {
    if (os(target) === "macos") {
      // macOS: Build and sign
      uiBuildSteps.push(command({
        label: `Playground (${target}) - Build`,
        key: `playground-build-${target}`,
        command: [
          "echo '--- Building UI'",
          `./x build-ui --target ${target}`,
          `cp -r "./target/${target}/release/bundle/macos/Divvun Runtime Playground.app" . 2>/dev/null || cp -r './target/release/bundle/macos/Divvun Runtime Playground.app' .`,
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

    if (os(target) === "windows") {
      const llvmArch = target.includes("aarch64") ? "ARM64" : "x64"
      uiBuildSteps.push(command({
        label: `Playground (${target}) - Build`,
        command: [
          `$$env:PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\Llvm\\${llvmArch}\\bin;C:\\MSYS2\\usr\\bin;" + $$env:PATH; echo '--- Building UI'; .\\x.ps1 build-ui --target ${target}`,
          `copy ".\\playground\\src-tauri\\target\\${target}\\release\\bundle\\msi\\Divvun Runtime Playground.msi" .`,
          `ren "Divvun Runtime Playground.msi" "divvun-rt-playground-${target}.msi"`,
          `buildkite-agent artifact upload divvun-rt-playground-${target}.msi`,
        ],
        agents: { queue: "windows" },
      }))
    }

    if (os(target) === "linux") {
      uiBuildSteps.push(command({
        label: `Playground (${target}) - Build`,
        command: [
          "echo '--- Building UI'",
          `./x build-ui --target ${target}`,
          `cp ./target/${target}/release/bundle/appimage/*.AppImage ./divvun-rt-playground-${target}.AppImage`,
          `buildkite-agent artifact upload divvun-rt-playground-${target}.AppImage`,
        ],
        agents: { queue: "linux" },
      }))
    }
  }

  const groups: BuildkitePipeline["steps"] = [
    {
      group: "CLI",
      key: "cli",
      steps: buildSteps,
    },
    {
      group: "Libs",
      key: "lib",
      steps: libBuildSteps,
    },
  ]

  if (PLAYGROUND_ENABLED && uiBuildSteps.length > 0) {
    groups.push({
      group: "Playground",
      key: "playground",
      steps: uiBuildSteps,
    })
  }

  const pipeline: BuildkitePipeline = { steps: groups }

  if (isRelease || isMainBranch) {
    const publishDeps = ["cli", "lib"]
    if (PLAYGROUND_ENABLED && uiBuildSteps.length > 0) {
      publishDeps.push("playground")
    }
    pipeline.steps.push(
      command({
        label: `Publish (${isRelease ? "Release" : "Dev"})`,
        command: "divvun-actions run divvun-runtime-publish",
        agents: { queue: "linux" },
        depends_on: publishDeps,
      }),
    )
  }

  return pipeline
}

export async function runDivvunRuntimePublish() {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error(
      "divvun-runtime-publish requires a version tag or main branch",
    )
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  // Resolve the publish version: tagged release uses the tag verbatim;
  // dev-latest derives a semver-compliant version from Cargo.toml + the build
  // timestamp + build number.
  let version: string
  if (isRelease) {
    version = builder.env.tag!
  } else {
    const cargoTomlText = await Deno.readTextFile("Cargo.toml")
    const versionMatch = cargoTomlText.match(/version\s*=\s*"(.*?)"/)
    const cargoVersion = versionMatch?.[1]
    if (typeof cargoVersion !== "string") {
      throw new Error("Could not determine version from Cargo.toml")
    }
    version = `v${
      versionAsDev(
        cargoVersion,
        builder.env.buildTimestamp,
        builder.env.buildNumber,
      )
    }`
  }

  const cliPublishTargets = CLI_RELEASE_TARGETS.filter(isMuslEnabled)
  const playgroundPublishTargets = PLAYGROUND_ENABLED
    ? PLAYGROUND_RELEASE_TARGETS.filter(isMuslEnabled)
    : []

  using tempDir = await makeTempDir()

  // Download CLI artifacts
  await Promise.all(
    cliPublishTargets.map((target) =>
      builder.downloadArtifacts(`divvun-runtime-${target}`, tempDir.path)
    ),
  )

  // Download playground artifacts
  await Promise.all(
    playgroundPublishTargets.map((target) => {
      if (os(target) === "linux") {
        return builder.downloadArtifacts(
          `divvun-rt-playground-${target}.AppImage`,
          tempDir.path,
        )
      }
      return builder.downloadArtifacts(
        `divvun-rt-playground-${target}`,
        tempDir.path,
      )
    }),
  )

  using archivePath = await makeTempDir({ prefix: "divvun-runtime-" })

  const allArtifacts: string[] = []

  // Move playground artifacts to archive path with version suffix.
  for (const target of playgroundPublishTargets) {
    if (os(target) === "linux") {
      const artifactName = `divvun-rt-playground-${target}.AppImage`
      const sourcePath = path.join(tempDir.path, artifactName)
      const destPath = path.join(
        archivePath.path,
        `divvun-rt-playground-${target}_${version}.AppImage`,
      )
      await fs.move(sourcePath, destPath, { overwrite: true })
      allArtifacts.push(destPath)
    } else {
      const artifactName = `divvun-rt-playground-${target}`
      const sourcePath = path.join(tempDir.path, artifactName)
      const destPath = path.join(
        archivePath.path,
        `${artifactName}_${version}.tar.gz`,
      )
      await fs.move(sourcePath, destPath, { overwrite: true })
      allArtifacts.push(destPath)
    }
  }

  // Download libs and rename with version suffix.
  await Promise.all(
    LIB_RELEASE_TARGETS.map((target) =>
      builder.downloadArtifacts(
        `libdivvun_runtime-${target}.tar.xz`,
        tempDir.path,
      )
    ),
  )

  for (const target of LIB_RELEASE_TARGETS) {
    const srcName = `libdivvun_runtime-${target}.tar.xz`
    const destName = `libdivvun_runtime-${target}-${version}.tar.xz`
    const sourcePath = path.join(tempDir.path, srcName)
    const destPath = path.join(archivePath.path, destName)
    await fs.move(sourcePath, destPath, { overwrite: true })
    allArtifacts.push(destPath)
  }

  for (const target of cliPublishTargets) {
    const ext = target.includes("windows") ? "zip" : "tgz"
    const outPath =
      `${archivePath.path}/divvun-runtime-${target}-${version}.${ext}`
    const inputPath = `${tempDir.path}/divvun-runtime-${target}${
      target.includes("windows") ? ".exe" : ""
    }`

    if (!target.includes("windows")) {
      await Deno.chmod(inputPath, 0o755)
    }

    const stagingDir = `divvun-runtime-${target}-${version}`
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(
      inputPath,
      `${stagingDir}/divvun-runtime${target.includes("windows") ? ".exe" : ""}`,
    )

    if (target.includes("windows")) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }

    allArtifacts.push(outPath)
  }

  // Create signed checksums for all artifacts
  const { checksumFile, signatureFile } = await createSignedChecksums(
    allArtifacts,
    await builder.secrets(),
  )

  // Move checksum files to archive path
  const checksumDest = path.join(archivePath.path, checksumFile)
  const signatureDest = path.join(archivePath.path, signatureFile)
  await fs.move(checksumFile, checksumDest, { overwrite: true })
  await fs.move(signatureFile, signatureDest, { overwrite: true })

  const gh = new GitHub(builder.env.repo)
  if (isRelease) {
    await gh.createRelease(
      builder.env.tag!,
      [`${archivePath.path}/*`],
      { latest: true },
    )
  } else {
    await gh.updateRelease(
      "dev-latest",
      [`${archivePath.path}/*`],
      { draft: false, prerelease: true, name: version },
    )
  }
}
