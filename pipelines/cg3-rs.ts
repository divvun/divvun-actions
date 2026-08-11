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

// The default-feature tools. cg-annotate and cg-merge-annotations are left out
// deliberately: they sit behind the `profiler` feature, which pulls in bundled
// SQLite and so needs a C cross-toolchain for every target.
const BINARIES = [
  "vislcg3",
  "cg-comp",
  "cg-proc",
  "cg-conv",
  "cg-relabel",
  "cg-mwesplit",
] as const

const CARGO_BUILD = `cargo build --release --locked -p cg3 --bins`

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

function binaryPath(target: string, name: string): string {
  const ext = target.includes("windows") ? ".exe" : ""
  return `target/${target}/release/${name}${ext}`
}

function msvcEnvCmd(target: string): string {
  return target.startsWith("aarch64") ? "arm64" : "x64"
}

function createSignStep(target: string, buildKey: string): CommandStep {
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""

  const steps: string[] = []
  for (const name of BINARIES) {
    const src = `target/${target}/release/${name}${ext}`
    const downloadPath = isWindows
      ? `target\\${target}\\release\\${name}${ext}`
      : src
    const signed = `signed/${src}`
    const signCmd = isWindows
      ? `divvun-actions sign ${src}`
      : `divvun-actions run macos-sign ${src}`

    steps.push(
      `echo '--- Downloading ${name} (unsigned)'`,
      `buildkite-agent artifact download '${downloadPath}' .`,
      `echo '--- Signing ${name}'`,
      signCmd,
      `mkdir -p signed/target/${target}/release`,
      `mv ${src} ${signed}`,
      `buildkite-agent artifact upload ${signed}`,
    )
  }

  return command({
    key: `sign-${target}`,
    label: "Sign",
    agents: { queue: "linux" },
    command: steps,
    depends_on: buildKey,
  })
}

export function pipelineCg3Rs(): BuildkitePipeline {
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

    const uploadCmds = BINARIES.map((name) =>
      `buildkite-agent artifact upload ${binaryPath(target, name)}`
    )

    const groupSteps: CommandStep[] = []

    if (isWindows) {
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [
          `msvc-env ${
            msvcEnvCmd(target)
          } | Invoke-Expression; ${CARGO_BUILD} --target ${target}`,
          ...uploadCmds,
        ],
        agents: { queue: "windows" },
      }))
    } else {
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [
          `${CARGO_BUILD} --target ${target}`,
          ...uploadCmds,
        ],
        agents: { queue: queue(target) },
        ...muslCrossEnv(target),
      }))
    }

    if (isSigned && (isMacos || isWindows)) {
      publishDependKeys.push(`sign-${target}`)
      groupSteps.push(createSignStep(target, buildKey))
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
        command: "divvun-actions run cg3-rs-publish",
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

export async function runCg3RsPublish() {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error("cg3-rs-publish requires a version tag or main branch")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish cg3-rs")
  }

  const isSigned = isRelease || isMainBranch

  using tempDir = await makeTempDir()

  await Promise.all(
    TARGETS.flatMap((target) => {
      const isWindows = target.includes("windows")
      const isMacos = target.includes("apple")
      const signed = isSigned && (isWindows || isMacos)
      const ext = isWindows ? ".exe" : ""

      return BINARIES.map((name) => {
        if (signed) {
          // Signed binaries are re-uploaded from the Linux sign agent, so the
          // artifact key always uses forward slashes.
          return builder.downloadArtifacts(
            `signed/target/${target}/release/${name}${ext}`,
            tempDir.path,
          )
        }

        // The Windows agent stores the artifact key with backslashes.
        const sep = isWindows ? "\\" : "/"
        return builder.downloadArtifacts(
          `target${sep}${target}${sep}release${sep}${name}${ext}`,
          tempDir.path,
        )
      })
    }),
  )

  let version: string
  if (isRelease) {
    version = builder.env.tag!
  } else {
    version = versionAsDev(
      await readCrateVersion("crates/cg3/Cargo.toml"),
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
  }

  using archivePath = await makeTempDir({ prefix: "cg3-" })
  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const isMacos = target.includes("apple")
    const signed = isSigned && (isWindows || isMacos)
    const ext = isWindows ? ".exe" : ""

    // All six tools go on PATH together, so keep them flat in the archive.
    const stagingDir = `cg3-${target}-${version}`
    await Deno.mkdir(stagingDir)

    for (const name of BINARIES) {
      const src = path.join(
        tempDir.path,
        ...(signed ? ["signed", "target"] : ["target"]),
        target,
        "release",
        `${name}${ext}`,
      )

      if (!isWindows) {
        // Artifact download drops the executable bit.
        await Deno.chmod(src, 0o755)
      }

      await Deno.copyFile(src, path.join(stagingDir, `${name}${ext}`))
    }

    const archiveExt = isWindows ? "zip" : "tgz"
    const outPath = path.join(
      archivePath.path,
      `cg3-${target}-${version}.${archiveExt}`,
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
