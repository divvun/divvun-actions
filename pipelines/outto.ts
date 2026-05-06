import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import { Tar, versionAsDev, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

// outto only ships for desktop. Mach-O embedding requires thin binaries, so
// no universal Mac build — pick one arch.
const TARGETS = [
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
]

// All four binaries form the toolkit: `outto` is the build CLI, the other
// three are payloads it embeds into installers it generates.
const BINARIES = ["outto", "outto-gui", "outto-uninstall"] as const
const PLATFORM_BINARY = {
  windows: "outto-sfx",
  macos: "outto-sfx-macos",
} as const

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
  if (target.includes("windows")) return "windows"
  if (target.includes("apple")) return "macos"
  throw new Error(`Unknown queue for target: ${target}`)
}

function binariesFor(target: string): readonly string[] {
  const sfx = target.includes("windows")
    ? PLATFORM_BINARY.windows
    : PLATFORM_BINARY.macos
  return [...BINARIES, sfx]
}

function binaryPath(target: string, name: string): string {
  const ext = target.includes("windows") ? ".exe" : ""
  return `target/${target}/release/${name}${ext}`
}

function createSignStep(
  target: string,
  buildKey: string,
): CommandStep {
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""
  const names = binariesFor(target)

  const steps: string[] = []
  for (const name of names) {
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

export function pipelineOutto(): BuildkitePipeline {
  const isRelease = builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  const steps: BuildkitePipeline["steps"] = []
  const publishDependKeys: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const buildKey = `build-${target}`
    const groupSteps: CommandStep[] = []

    // outto requires nightly + -Zbuild-std=std because [profile.release]
    // sets panic = "immediate-abort".
    const buildCmd =
      `cargo +nightly build --release --workspace -Zbuild-std=std --target ${target}`

    const uploadCmds = binariesFor(target).map((name) =>
      `buildkite-agent artifact upload ${binaryPath(target, name)}`
    )

    if (isWindows) {
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [buildCmd, ...uploadCmds],
        agents: { queue: queue(target) },
      }))

      // outto-core is platform-neutral; outto-windows admin tests are
      // marked #[ignore] and skipped here.
      groupSteps.push(command({
        key: `test-${target}`,
        label: "Test",
        command: [
          `cargo +nightly test -p outto-core`,
          `cargo +nightly test -p outto-windows`,
        ],
        agents: { queue: queue(target) },
        depends_on: buildKey,
      }))
    } else {
      groupSteps.push(command({
        key: buildKey,
        label: "Build",
        command: [buildCmd, ...uploadCmds],
        agents: { queue: queue(target) },
      }))

      groupSteps.push(command({
        key: `test-${target}`,
        label: "Test",
        command: [
          `cargo +nightly test -p outto-core`,
          `cargo +nightly test -p outto-macos`,
        ],
        agents: { queue: queue(target) },
        depends_on: buildKey,
      }))
    }

    if (isRelease) {
      const signKey = `sign-${target}`
      publishDependKeys.push(signKey)
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
        command: "divvun-actions run outto-publish",
        agents: { queue: "linux" },
        depends_on: publishDependKeys,
      }),
    )
  }

  return { steps }
}

export async function runOuttoPublish() {
  const isRelease = builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error("outto-publish requires a version tag or main branch")
  }

  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  using tempDir = await makeTempDir()

  // Fetch every binary for every target. Signed releases land under
  // signed/target/...; dev builds keep the raw target/... layout.
  if (isRelease) {
    for (const target of TARGETS) {
      for (const name of binariesFor(target)) {
        const ext = target.includes("windows") ? ".exe" : ""
        await builder.downloadArtifacts(
          `signed/target/${target}/release/${name}${ext}`,
          tempDir.path,
        )
      }
    }
  } else {
    await Promise.all(
      TARGETS.flatMap((target) => {
        const isWindows = target.includes("windows")
        const ext = isWindows ? ".exe" : ""
        const sep = isWindows ? "\\" : "/"
        return binariesFor(target).map((name) =>
          builder.downloadArtifacts(
            `target${sep}${target}${sep}release${sep}${name}${ext}`,
            tempDir.path,
          )
        )
      }),
    )
  }

  // Version comes from crates/cli/Cargo.toml — that's the publishable CLI.
  let version: string
  if (isRelease) {
    version = builder.env.tag!
  } else {
    const cargoTomlText = await Deno.readTextFile("crates/cli/Cargo.toml")
    const versionMatch = cargoTomlText.match(/version\s*=\s*"(.*?)"/)
    const cargoVersion = versionMatch?.[1]
    if (typeof cargoVersion !== "string") {
      throw new Error("Could not determine version from crates/cli/Cargo.toml")
    }
    version = versionAsDev(
      cargoVersion,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
  }

  using archivePath = await makeTempDir({ prefix: "outto-" })
  const allArtifacts: string[] = []

  for (const target of TARGETS) {
    const isWindows = target.includes("windows")
    const isSigned = !!isRelease
    const ext = isWindows ? ".exe" : ""
    const names = binariesFor(target)

    // Mirror the build-release script layout: outto in bin/, runtime
    // helpers in libexec/. Consumers can drop this into a system PATH.
    const stagingDir = `outto-${target}-${version}`
    await Deno.mkdir(path.join(stagingDir, "bin"), { recursive: true })
    await Deno.mkdir(path.join(stagingDir, "libexec"), { recursive: true })

    for (const name of names) {
      const src = path.join(
        tempDir.path,
        ...(isSigned ? ["signed", "target"] : ["target"]),
        target,
        "release",
        `${name}${ext}`,
      )

      if (!isWindows) {
        await Deno.chmod(src, 0o755)
      }

      const dest = name === "outto"
        ? path.join(stagingDir, "bin", `${name}${ext}`)
        : path.join(stagingDir, "libexec", `${name}${ext}`)

      await Deno.copyFile(src, dest)
    }

    const archiveExt = isWindows ? "zip" : "tgz"
    const outPath = path.join(
      archivePath.path,
      `outto-${target}-${version}.${archiveExt}`,
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
