import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import { Tar, versionAsDev, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const TARGETS = [
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
  "x86_64-pc-windows-msvc",
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

function queue(target: string): string {
  if (target.includes("-musl")) return "alpine"
  if (target.includes("windows")) return "windows"
  if (target.includes("apple")) return "macos"
  throw new Error(`Unknown queue for target: ${target}`)
}

function createSignStep(
  platform: "windows" | "macos",
  arch: string,
  buildKey: string,
): CommandStep {
  const ext = platform === "windows" ? ".exe" : ""
  const binaryPath = `target/${arch}/release/box${ext}`
  const signedPath = `signed/${binaryPath}`

  const downloadPath = platform === "windows"
    ? `target\\${arch}\\release\\box${ext}`
    : binaryPath

  const signCommand = platform === "windows"
    ? `divvun-actions sign ${binaryPath}`
    : `divvun-actions run macos-sign ${binaryPath}`

  return command({
    key: `sign-${arch}`,
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

export function pipelineBox(): BuildkitePipeline {
  const isRelease = builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  const steps: BuildkitePipeline["steps"] = []
  const publishDependKeys: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const isMacos = target.includes("apple")
    const binaryName = isWindows ? "box.exe" : "box"
    const binaryPath = `target/${target}/release/${binaryName}`
    const buildKey = `build-${target}`

    const groupSteps: CommandStep[] = []

    if (isWindows) {
      const llvmArch = target.includes("aarch64") ? "ARM64" : "x64"
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [
          `$$env:PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\Llvm\\${llvmArch}\\bin;C:\\MSYS2\\usr\\bin;" + $$env:PATH; cargo build -p box-cli --bin box --release --target ${target}`,
          `buildkite-agent artifact upload ${binaryPath}`,
        ],
        agents: { queue: "windows" },
      }))
    } else {
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [
          `cargo build -p box-cli --bin box --release --target ${target}`,
          `buildkite-agent artifact upload ${binaryPath}`,
        ],
        agents: { queue: queue(target) },
        ...muslCrossEnv(target),
      }))
    }

    if (isRelease && (isMacos || isWindows)) {
      const signKey = `sign-${target}`
      publishDependKeys.push(signKey)
      groupSteps.push(
        createSignStep(isWindows ? "windows" : "macos", target, buildKey),
      )
    } else {
      publishDependKeys.push(buildKey)
    }

    steps.push({
      group: target,
      steps: groupSteps,
    })
  }

  if (isRelease || isMainBranch) {
    steps.push(
      command({
        label: `Publish (${isRelease ? "Release" : "Dev"})`,
        command: "divvun-actions run box-publish",
        agents: { queue: "linux" },
        depends_on: publishDependKeys,
      }),
    )
  }

  return { steps }
}

function muslCrossEnv(
  target: string,
): { env: Record<string, string> } | Record<string, never> {
  if (target === "aarch64-unknown-linux-musl") {
    const sysroot = "/opt/sysroot-aarch64"
    const linkerArgs = [
      `--target=aarch64-linux-musl`,
      `--sysroot=${sysroot}`,
      `-fuse-ld=lld`,
      `--rtlib=compiler-rt`,
      `--unwindlib=libunwind`,
    ].map((arg) => `-C link-arg=${arg}`).join(" ")
    return {
      env: {
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: "clang",
        CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS: linkerArgs,
        CC_aarch64_unknown_linux_musl: "clang",
        CFLAGS_aarch64_unknown_linux_musl:
          `--target=aarch64-linux-musl --sysroot=${sysroot}`,
      },
    }
  }
  if (target === "x86_64-unknown-linux-musl") {
    const linkerArgs = [
      `-fuse-ld=lld`,
      `--rtlib=compiler-rt`,
      `--unwindlib=libunwind`,
    ].map((arg) => `-C link-arg=${arg}`).join(" ")
    return {
      env: {
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: "clang",
        CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_RUSTFLAGS: linkerArgs,
        CC_x86_64_unknown_linux_musl: "clang",
      },
    }
  }
  return {}
}

export async function runBoxPublish() {
  const isRelease = builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error("box-publish requires a version tag or main branch")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  using tempDir = await makeTempDir()

  // Download artifacts
  if (isRelease) {
    await builder.downloadArtifacts(
      `signed/target/*-apple-darwin/release/box`,
      tempDir.path,
    )
    await builder.downloadArtifacts(
      `signed/target/*-pc-windows-msvc/release/box.exe`,
      tempDir.path,
    )
    await builder.downloadArtifacts(
      `target/*-linux-*/release/box`,
      tempDir.path,
    )
  } else {
    await Promise.all(
      TARGETS.map((target) => {
        const binaryName = target.includes("windows") ? "box.exe" : "box"
        return builder.downloadArtifacts(
          `target/${target}/release/${binaryName}`,
          tempDir.path,
        )
      }),
    )
  }

  // Determine version string for archive names
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
    version = versionAsDev(
      cargoVersion,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
  }

  using archivePath = await makeTempDir({ prefix: "box-" })
  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const isMacos = target.includes("apple")
    const isSigned = isRelease && (isMacos || isWindows)
    const ext = isWindows ? "zip" : "tgz"
    const binaryName = isWindows ? "box.exe" : "box"

    const inputPath = path.join(
      tempDir.path,
      ...(isSigned ? ["signed", "target"] : ["target"]),
      target,
      "release",
      binaryName,
    )

    const outPath = path.join(
      archivePath.path,
      `box-${target}-${version}.${ext}`,
    )

    if (!isWindows) {
      await Deno.chmod(inputPath, 0o755)
    }

    const stagingDir = `box-${target}-${version}`
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(
      inputPath,
      path.join(stagingDir, binaryName),
    )

    if (isWindows) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }

    allArtifacts.push(outPath)
  }

  // Create signed checksums
  const { checksumFile, signatureFile } = await createSignedChecksums(
    allArtifacts,
    await builder.secrets(),
  )

  const checksumDest = path.join(archivePath.path, checksumFile)
  const signatureDest = path.join(archivePath.path, signatureFile)
  await fs.copy(checksumFile, checksumDest, { overwrite: true })
  await fs.copy(signatureFile, signatureDest, { overwrite: true })
  await Deno.remove(checksumFile)
  await Deno.remove(signatureFile)

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
      { draft: false, prerelease: true, name: `v${version}` },
    )
  }
}
