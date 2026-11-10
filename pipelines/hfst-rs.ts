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

  const signCommand = platform === "windows"
    ? `divvun-actions sign ${src}`
    : `divvun-actions run macos-sign ${src}`

  return command({
    key: `sign-${target}`,
    label: "Sign",
    agents: { queue: "linux" },
    command: [
      "echo '--- Downloading unsigned binary'",
      downloadBinaryCmd(src),
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

const WASM_PACKAGE: WasmPackage = {
  crate: "crates/hfst-wasm",
  packageDir: "hfst",
  name: "@divvun/hfst",
  // The test build also builds the hfst tools and the transducer fixtures the
  // suite reads, and the release build refuses a module that carries the
  // compilers or the algebra. The suite runs the API contract and parity with
  // the native library in each runtime the agent has, and skips the rest.
  checks: [
    "echo '--- Building @divvun/hfst and its test build'",
    "node js/build.mjs --test",
    "echo '--- Its declarations'",
    "(cd js && deno check)",
    "echo '--- The JavaScript suite'",
    "node js/test/run.mjs",
  ],
}

const PYTHON_PACKAGE: PythonPackage = {
  distribution: "divvun_hfst",
  wheelEnv: "DIVVUN_HFST_WHEEL",
  buildEnv: {
    // chumsky, through the nfst compilers, needs psm, whose arm64 Windows
    // assembly must be preprocessed, and psm asks for that only of a compiler
    // that is not MSVC-like. cargo-xwin's clang-cl is, so the Windows wheels
    // are built with its plain clang driver.
    XWIN_CROSS_COMPILER: "clang",
  },
  // Building them compiles hfst, which overflows the macOS agent's disk.
  fixtures: {
    build: "node js/test/fixtures.mjs",
    env: "DIVVUN_HFST_FIXTURES",
  },
}

export function pipelineHfstRs(): BuildkitePipeline {
  // The tools are released from `v<version>`; @divvun/hfst and divvun-hfst,
  // each versioned on its own, from `wasm/v<version>` and `python/v<version>`.
  const pkg = packageReleaseOf(builder.env.tag)
  const isRelease = !!builder.env.tag?.match(/^v\d/)
  const isMainBranch = builder.env.branch === "main"
  // Sign everything we publish, dev-latest included: an unsigned Mach-O
  // binary is killed by Gatekeeper the moment someone downloads it.
  const isSigned = isRelease || isMainBranch
  // A release tag builds only what it releases. Every other build builds
  // everything, so a package that breaks on the library fails on main.
  const buildsPackage = (name: "wasm" | "python") =>
    pkg ? pkg.package === name : !isRelease

  const steps: BuildkitePipeline["steps"] = []
  const publishDependKeys: string[] = []

  for (const target of pkg ? [] : TARGETS) {
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

  if (buildsPackage("wasm")) {
    steps.push(wasmPackageStep(command, WASM_PACKAGE))
    publishDependKeys.push("wasm-package")
  }
  const pythonSteps = pythonPackageSteps(command, PYTHON_PACKAGE)
  if (buildsPackage("python")) {
    steps.push({ group: "divvun-hfst", steps: pythonSteps })
    publishDependKeys.push(...pythonSteps.map((step) => step.key as string))
  }

  // The GitHub release of the tools, or dev-latest from main, once everything
  // the build built has passed: on main that includes both packages.
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

  // An npm or PyPI version cannot be published again, so each package goes
  // from its own tag only, once everything it is made of has passed.
  if (pkg?.package === "wasm") {
    steps.push(command({
      label: "Publish @divvun/hfst to npm",
      command: "divvun-actions run hfst-rs-npm-publish",
      agents: { queue: "linux" },
      depends_on: "wasm-package",
    }))
  }
  if (pkg?.package === "python") {
    steps.push(command({
      label: "Publish divvun-hfst to PyPI",
      command: "divvun-actions run hfst-rs-pypi-publish",
      agents: { queue: "linux" },
      depends_on: pythonSteps.map((step) => step.key as string),
    }))
  }

  return { steps }
}

/** Publishes @divvun/hfst from a `wasm/v<version>` tag naming its version. */
export async function runHfstRsNpmPublish() {
  const pkg = packageReleaseOf(builder.env.tag)
  if (pkg?.package !== "wasm") {
    throw new Error("hfst-rs-npm-publish requires a wasm/v<version> tag")
  }
  await publishToNpm(WASM_PACKAGE, pkg.version)
}

/** Publishes divvun-hfst from a `python/v<version>` tag naming its version. */
export async function runHfstRsPypiPublish() {
  const pkg = packageReleaseOf(builder.env.tag)
  if (pkg?.package !== "python") {
    throw new Error("hfst-rs-pypi-publish requires a python/v<version> tag")
  }
  await publishToPypi(PYTHON_PACKAGE, pkg.version)
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

      return downloadBinary(`target/${target}/release/${name}`, tempDir.path)
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

    const stagingDir = assetStem("hfst", target, version)
    await Deno.mkdir(stagingDir)
    await Deno.copyFile(inputPath, path.join(stagingDir, name))

    const ext = isWindows ? "zip" : "tgz"
    const outPath = path.join(
      archivePath.path,
      assetFileName("hfst", target, version, ext),
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
