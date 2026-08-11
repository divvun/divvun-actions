import * as fs from "@std/fs"
import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import { Tar, versionAsDev, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const TARGETS = [
  "aarch64-apple-darwin",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-musl",
  "aarch64-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
]

// hfst is a busybox-style multiplexer: a single binary that dispatches on
// argv[0]. Archives ship it bare -- `hfst install-symlinks` creates the legacy
// hfst-* names that Giella build systems expect on PATH.
const BINARY = "hfst"

// Branch-pinned git dependencies (rustfst, box-format, fastvlq) mean an
// unlocked build can silently drift off the reviewed revisions.
const CARGO_BUILD = `cargo build --release --locked -p hfst-cli --bin ${BINARY}`

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

function binaryName(target: string): string {
  return target.includes("windows") ? `${BINARY}.exe` : BINARY
}

function msvcEnvCmd(target: string): string {
  return target.startsWith("aarch64") ? "arm64" : "x64"
}

function createSignStep(
  platform: "windows" | "macos",
  target: string,
  buildKey: string,
): CommandStep {
  const name = binaryName(target)
  const src = `target/${target}/release/${name}`
  const signedPath = `signed/${src}`

  const downloadPath = platform === "windows"
    ? `target\\${target}\\release\\${name}`
    : src

  const signCommand = platform === "windows"
    ? `divvun-actions sign ${src}`
    : `divvun-actions run macos-sign ${src}`

  return command({
    key: `sign-${target}`,
    label: "Sign",
    agents: { queue: "linux" },
    command: [
      "echo '--- Downloading unsigned binary'",
      `buildkite-agent artifact download '${downloadPath}' .`,
      "echo '--- Signing'",
      signCommand,
      "echo '--- Uploading signed binary'",
      `mkdir -p signed/target/${target}/release`,
      `mv ${src} ${signedPath}`,
      `buildkite-agent artifact upload ${signedPath}`,
    ],
    depends_on: buildKey,
  })
}

export function pipelineHfstRs(): BuildkitePipeline {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"
  // Sign everything we publish, dev-latest included: an unsigned Mach-O
  // binary is killed by Gatekeeper the moment someone downloads it.
  const isSigned = isRelease || isMainBranch

  const steps: BuildkitePipeline["steps"] = []
  const publishDependKeys: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const isMacos = target.includes("apple")
    const buildKey = `build-${target}`
    const artifactPath = `target/${target}/release/${binaryName(target)}`

    const groupSteps: CommandStep[] = []

    if (isWindows) {
      // mimalloc, blake3 and psm all compile C/asm through cc-rs, so the
      // build needs a full MSVC environment, not just cargo's own probing.
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [
          `msvc-env ${
            msvcEnvCmd(target)
          } | Invoke-Expression; ${CARGO_BUILD} --target ${target}`,
          `buildkite-agent artifact upload ${artifactPath}`,
        ],
        agents: { queue: "windows" },
      }))
    } else {
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [
          `${CARGO_BUILD} --target ${target}`,
          `buildkite-agent artifact upload ${artifactPath}`,
        ],
        agents: { queue: queue(target) },
        ...muslCrossEnv(target),
      }))
    }

    if (isSigned && (isMacos || isWindows)) {
      publishDependKeys.push(`sign-${target}`)
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
        command: "divvun-actions run hfst-rs-publish",
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

// Resolve a crate's version, following `version.workspace = true` inheritance
// to the workspace root Cargo.toml's [workspace.package].
async function readCrateVersion(crateTomlPath: string): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const crate = toml.parse(await Deno.readTextFile(crateTomlPath)) as any
  const version = crate?.package?.version
  if (typeof version === "string") {
    return version
  }
  if (version?.workspace === true) {
    // deno-lint-ignore no-explicit-any
    const root = toml.parse(await Deno.readTextFile("Cargo.toml")) as any
    const workspaceVersion = root?.workspace?.package?.version
    if (typeof workspaceVersion === "string") {
      return workspaceVersion
    }
  }
  throw new Error(`Could not determine version from ${crateTomlPath}`)
}

export async function runHfstRsPublish() {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error("hfst-rs-publish requires a version tag or main branch")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish hfst-rs")
  }

  const isSigned = isRelease || isMainBranch

  using tempDir = await makeTempDir()

  await Promise.all(
    TARGETS.map((target) => {
      const isWindows = target.includes("windows")
      const isMacos = target.includes("apple")
      const name = binaryName(target)

      if (isSigned && (isWindows || isMacos)) {
        // Signed binaries are re-uploaded from the Linux sign agent, so the
        // artifact key always uses forward slashes.
        return builder.downloadArtifacts(
          `signed/target/${target}/release/${name}`,
          tempDir.path,
        )
      }

      // The Windows agent stores the artifact key with backslashes.
      const sep = isWindows ? "\\" : "/"
      return builder.downloadArtifacts(
        `target${sep}${target}${sep}release${sep}${name}`,
        tempDir.path,
      )
    }),
  )

  let version: string
  if (isRelease) {
    version = builder.env.tag!
  } else {
    version = versionAsDev(
      await readCrateVersion("crates/hfst-cli/Cargo.toml"),
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
  }

  using archivePath = await makeTempDir({ prefix: "hfst-" })
  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const isMacos = target.includes("apple")
    const signed = isSigned && (isWindows || isMacos)
    const name = binaryName(target)

    const inputPath = path.join(
      tempDir.path,
      ...(signed ? ["signed", "target"] : ["target"]),
      target,
      "release",
      name,
    )

    if (!isWindows) {
      // Artifact download drops the executable bit.
      await Deno.chmod(inputPath, 0o755)
    }

    const stagingDir = `hfst-${target}-${version}`
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(inputPath, path.join(stagingDir, name))

    const ext = isWindows ? "zip" : "tgz"
    const outPath = path.join(
      archivePath.path,
      `hfst-${target}-${version}.${ext}`,
    )

    if (isWindows) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }

    allArtifacts.push(outPath)
  }

  const { checksumFile, signatureFile } = await createSignedChecksums(
    allArtifacts,
    await builder.secrets(),
  )

  // createSignedChecksums writes into cwd, which is a different filesystem
  // from the temp archive dir, so copy rather than rename (EXDEV).
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
