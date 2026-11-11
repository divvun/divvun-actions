import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { downloadBinary, downloadBinaryCmd } from "~/util/artifact_download.ts"
import { assetFileName, assetStem } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums, release } from "~/util/hash.ts"
import { Tar, versionAsDev, Zip } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import {
  packageReleaseOf,
  publishToNpm,
  publishToPypi,
  type PythonPackage,
  pythonPackageSteps,
  type WasmPackage,
  wasmPackageStep,
} from "~/util/binding_packages.ts"

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

// The tools live in cg3-cli; cg3 is the library alone.
const CARGO_BUILD = `cargo build --release --locked -p cg3-cli --bins`

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
    const signed = `signed/${src}`
    const signCmd = isWindows
      ? `divvun-actions sign ${src}`
      : `divvun-actions run macos-sign ${src}`

    steps.push(
      `echo '--- Downloading ${name} (unsigned)'`,
      downloadBinaryCmd(src),
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

/**
 * What a release tag releases. The library and the tools share one version
 * and are released from `v<version>`; @divvun/cg3 and divvun-cg3 are each
 * versioned on their own and released from `wasm/v<version>` and
 * `python/v<version>`.
 */
type Release = { part: "tools" | "wasm" | "python"; version: string }

function releaseOf(tag: string | undefined): Release | null {
  const pkg = packageReleaseOf(tag)
  if (pkg) return { part: pkg.package, version: pkg.version }
  const match = tag?.match(/^v(\d.*)$/)
  return match ? { part: "tools", version: match[1] } : null
}

const WASM_PACKAGE: WasmPackage = {
  crate: "crates/cg3-wasm",
  packageDir: "cg3",
  name: "@divvun/cg3",
  // The library on wasm32, the binding's tests under Node, the declarations
  // under `deno check`, and the JavaScript suite, which runs the API contract
  // and byte-for-byte parity with vislcg3 over the corpus in each runtime the
  // agent has and skips the rest.
  checks: [
    "echo '--- The library on wasm32'",
    "cargo check --locked -p cg3 --lib --target wasm32-unknown-unknown",
    "echo '--- Tests under Node'",
    "cargo test --locked -p cg3-wasm --target wasm32-unknown-unknown",
    "echo '--- Building @divvun/cg3 and its test build'",
    "node js/build.mjs --test",
    "echo '--- Its declarations'",
    "deno check",
    "echo '--- Checking it against vislcg3'",
    "node js/test/run.mjs",
  ],
}

// The Python suite builds the cg3 tools and the EXTERNAL example itself, and
// checks parity with vislcg3, cg-comp, cg-conv, cg-mwesplit, cg-proc and
// cg-relabel. A linux agent writes the tool parity cases' fixtures once, with
// node, so an agent that tests a wheel needs no node of its own.
const PYTHON_PACKAGE: PythonPackage = {
  distribution: "divvun_cg3",
  wheelEnv: "CG3_WHEEL",
  fixtures: {
    build: "node js/test/tool-fixtures.mjs",
    env: "CG3_TOOL_FIXTURES",
  },
}

export function pipelineCg3Rs(): BuildkitePipeline {
  const release = releaseOf(builder.env.tag)
  const isRelease = release?.part === "tools"
  const isMainBranch = builder.env.branch === "main"
  // Sign everything we publish, dev-latest included: an unsigned Mach-O
  // binary is killed by Gatekeeper the moment someone downloads it.
  const isSigned = isRelease || isMainBranch
  // A release tag builds only what it releases. Every other build builds
  // everything, so a package that breaks on the library fails on main.
  const builds = (part: Release["part"]) =>
    release === null || release.part === part

  const steps: BuildkitePipeline["steps"] = []
  const publishDependKeys: string[] = []

  for (const target of builds("tools") ? TARGETS : []) {
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

  if (builds("wasm")) {
    steps.push(wasmPackageStep(command, WASM_PACKAGE))
    publishDependKeys.push("wasm-package")
  }
  const pythonSteps = pythonPackageSteps(command, PYTHON_PACKAGE)
  if (builds("python")) {
    steps.push({ group: "divvun-cg3", steps: pythonSteps })
    publishDependKeys.push(...pythonSteps.map((step) => step.key as string))
  }

  // The GitHub release of the tools, or dev-latest from main, once everything
  // the build built has passed: on main that includes both packages.
  if (isRelease || isMainBranch) {
    steps.push(
      command({
        key: "publish",
        label: `Publish (${isRelease ? "Release" : "Dev"})`,
        command: "divvun-actions run cg3-rs-publish",
        agents: { queue: "linux" },
        depends_on: publishDependKeys,
      }),
    )
  }

  // An npm or PyPI version cannot be published again, so each package goes
  // from its own tag only, once everything it is made of has passed.
  if (release?.part === "wasm") {
    steps.push(command({
      label: "Publish @divvun/cg3 to npm",
      command: "divvun-actions run cg3-rs-npm-publish",
      agents: { queue: "linux" },
      depends_on: "wasm-package",
    }))
  }
  if (release?.part === "python") {
    steps.push(command({
      label: "Publish divvun-cg3 to PyPI",
      command: "divvun-actions run cg3-rs-pypi-publish",
      agents: { queue: "linux" },
      depends_on: pythonSteps.map((step) => step.key as string),
    }))
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
  const isRelease = releaseOf(builder.env.tag)?.part === "tools"
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

        return downloadBinary(
          `target/${target}/release/${name}${ext}`,
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
    const stagingDir = assetStem("cg3", target, version)
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
      assetFileName("cg3", target, version, archiveExt),
    )

    if (isWindows) {
      await Zip.create([stagingDir], outPath)
    } else {
      await Tar.createFlatTgz([stagingDir], outPath)
    }

    allArtifacts.push(outPath)
  }

  await createSignedChecksums(
    allArtifacts.map((file) => path.basename(file)),
    await builder.ciKey(),
    release(builder.env, {
      tag: isRelease ? builder.env.tag! : "dev-latest",
      version,
    }),
    archivePath.path,
  )

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

/**
 * Publishes the @divvun/cg3 package the wasm-package step built, on a
 * `wasm/v<version>` tag only, and only when the tag names the package's
 * version. Needs the `npm/token` secret: an npm token allowed to publish to
 * the @divvun scope.
 */
export async function runCg3RsNpmPublish() {
  const release = releaseOf(builder.env.tag)
  if (release?.part !== "wasm") {
    throw new Error("cg3-rs-npm-publish requires a wasm/v<version> tag")
  }
  await publishToNpm(WASM_PACKAGE, release.version)
}

/**
 * Publishes the divvun-cg3 sdist and every wheel in one upload, on a
 * `python/v<version>` tag only, and only when there is a file for each and
 * every one names the tag's version. Needs
 * the `pypiToken` secret, an account-wide PyPI token: the first release creates
 * the divvun-cg3 project under its account.
 */
export async function runCg3RsPypiPublish() {
  const release = releaseOf(builder.env.tag)
  if (release?.part !== "python") {
    throw new Error("cg3-rs-pypi-publish requires a python/v<version> tag")
  }
  await publishToPypi(PYTHON_PACKAGE, release.version)
}
