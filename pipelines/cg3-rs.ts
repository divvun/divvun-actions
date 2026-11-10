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

// binaryen, for wasm-opt, which js/build.mjs runs.
const BINARYEN = "version_123"

// maturin builds the divvun-cg3 wheels from python/. 1.9.4 is the first to set
// PYO3_BUILD_EXTENSION_MODULE, which pyo3 0.30 needs; the zig extra brings the
// linker the Linux wheels are made with.
const MATURIN = "maturin[zig]>=1.9.4,<2"

/** One divvun-cg3 wheel: an abi3 wheel for CPython 3.11 and later. */
type Wheel = {
  target: string
  queue: string
  /**
   * The platform tag zig links the wheel for: the oldest glibc or musl it
   * claims, where a native build would claim the agent's own glibc. Absent for
   * the macOS wheel, built natively, and the Windows ones, which link with the
   * cargo-xwin the linux image carries.
   */
  platform?: string
  /** Whether the agent that builds the wheel can also run it, to test it. */
  tested?: boolean
}

const WHEELS: Wheel[] = [
  {
    target: "x86_64-unknown-linux-gnu",
    queue: "linux",
    platform: "manylinux2014",
    tested: true,
  },
  {
    target: "aarch64-unknown-linux-gnu",
    queue: "linux",
    platform: "manylinux2014",
  },
  {
    target: "x86_64-unknown-linux-musl",
    queue: "linux",
    platform: "musllinux_1_2",
  },
  {
    target: "aarch64-unknown-linux-musl",
    queue: "linux",
    platform: "musllinux_1_2",
  },
  { target: "x86_64-pc-windows-msvc", queue: "linux" },
  { target: "aarch64-pc-windows-msvc", queue: "linux" },
  { target: "aarch64-apple-darwin", queue: "macos", tested: true },
]

const PYTHON_DIST = "dist/python"

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

// The wasm-bindgen CLI must be the exact version cg3-wasm pins, so read the pin
// rather than repeat it here.
function wasmBindgenVersion(): string {
  // deno-lint-ignore no-explicit-any
  const manifest = toml.parse(
    Deno.readTextFileSync("crates/cg3-wasm/Cargo.toml"),
  ) as any
  const pin = manifest?.dependencies?.["wasm-bindgen"]
  const version = typeof pin === "string" ? pin.replace(/^=/, "") : undefined
  if (!version) {
    throw new Error("crates/cg3-wasm/Cargo.toml does not pin wasm-bindgen")
  }
  return version
}

/**
 * Builds the @divvun/cg3 npm package and checks it: the library on wasm32,
 * the binding's tests under Node, the declarations under `deno check`, and the
 * JavaScript suite, which runs the API contract and byte-for-byte parity with
 * vislcg3 over the corpus in each runtime the agent has and skips the rest.
 * The image has no wasm32 target, wasm-bindgen or wasm-opt, so the step
 * installs them. The package is uploaded for the npm publish step.
 */
function wasmPackageStep(): CommandStep {
  const binaryen = `/tmp/binaryen-${BINARYEN}`
  return command({
    key: "wasm-package",
    label: "wasm package",
    agents: { queue: "linux" },
    command: [
      "echo '--- Installing the wasm tools'",
      "rustup target add wasm32-unknown-unknown",
      `cargo binstall -y --force wasm-bindgen-cli@${wasmBindgenVersion()}`,
      `curl -sSfL https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN}/binaryen-${BINARYEN}-x86_64-linux.tar.gz | tar xz -C /tmp`,
      `export PATH="${binaryen}/bin:$$PATH"`,
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
      "tar -czf cg3-npm-package.tgz -C js cg3",
      "buildkite-agent artifact upload cg3-npm-package.tgz",
    ],
  })
}

function wheelKey(wheel: Wheel): string {
  return `python-wheel-${wheel.target}`
}

function sdistStep(): CommandStep {
  return command({
    key: "python-sdist",
    label: ":python: sdist",
    agents: { queue: "linux" },
    command: [
      `(cd python && uvx --from '${MATURIN}' maturin sdist --out ../${PYTHON_DIST})`,
      `buildkite-agent artifact upload '${PYTHON_DIST}/*.tar.gz'`,
    ],
  })
}

function wheelStep(wheel: Wheel): CommandStep {
  const zig = wheel.platform ? ` --zig --compatibility ${wheel.platform}` : ""
  return command({
    key: wheelKey(wheel),
    label: `:python: ${wheel.target}`,
    agents: { queue: wheel.queue },
    command: [
      `rustup target add ${wheel.target}`,
      `(cd python && uvx --from '${MATURIN}' maturin build --release --locked --target ${wheel.target}${zig} --out ../${PYTHON_DIST})`,
      `buildkite-agent artifact upload '${PYTHON_DIST}/*.whl'`,
    ],
  })
}

/**
 * Installs the wheel `wheel`'s step built into a fresh CPython 3.11, the oldest
 * the abi3 wheels serve, and runs python/tests against it: the API, the
 * package's metadata and contents, and byte-for-byte parity with vislcg3 over
 * the corpus, loaded both as text and as .cg3b. The tests build vislcg3,
 * cg-comp and the EXTERNAL example themselves.
 */
function wheelTestStep(wheel: Wheel): CommandStep {
  const venv = "/tmp/divvun-cg3-test"
  const wheels = `${PYTHON_DIST}/*.whl`
  return command({
    key: `python-test-${wheel.target}`,
    label: `:python: test ${wheel.target}`,
    agents: { queue: wheel.queue },
    depends_on: wheelKey(wheel),
    command: [
      `buildkite-agent artifact download --step ${
        wheelKey(wheel)
      } '${wheels}' .`,
      `rm -rf ${venv} && uv venv --python 3.11 ${venv}`,
      `uv pip install --python ${venv}/bin/python ${wheels} pytest`,
      `export CG3_WHEEL=$$(ls ${wheels})`,
      `(cd python && ${venv}/bin/pytest -q -rs -p no:cacheprovider)`,
    ],
  })
}

/**
 * The divvun-cg3 sdist, a step per wheel, and a step testing each wheel its
 * agent can run. Each uploads what it built; the PyPI publish step downloads
 * them all and uploads them in one go.
 */
function pythonPackageSteps(): CommandStep[] {
  return [
    sdistStep(),
    ...WHEELS.map(wheelStep),
    ...WHEELS.filter((w) => w.tested).map(wheelTestStep),
  ]
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

  steps.push(wasmPackageStep())
  publishDependKeys.push("wasm-package")
  const pythonSteps = pythonPackageSteps()
  steps.push({ group: "divvun-cg3", steps: pythonSteps })
  publishDependKeys.push(...pythonSteps.map((step) => step.key as string))

  // Nothing publishes unless every target, the wasm package and the wheels
  // built, so a release never ships the tools without both packages or the
  // other way round. npm and PyPI go last: a GitHub release can be made again,
  // an npm or PyPI version cannot.
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

  if (isRelease) {
    steps.push(
      command({
        label: "Publish @divvun/cg3 to npm",
        command: "divvun-actions run cg3-rs-npm-publish",
        agents: { queue: "linux" },
        depends_on: "publish",
      }),
      command({
        label: "Publish divvun-cg3 to PyPI",
        command: "divvun-actions run cg3-rs-pypi-publish",
        agents: { queue: "linux" },
        depends_on: "publish",
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
 * Publishes the @divvun/cg3 package the wasm-package step built, on a version
 * tag only, and only when the tag names the package's version. Needs the
 * `npm/token` secret: an npm token allowed to publish to the @divvun scope.
 */
export async function runCg3RsNpmPublish() {
  const tag = builder.env.tag
  if (!tag?.match(/^v/)) {
    throw new Error("cg3-rs-npm-publish requires a version tag")
  }

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts("cg3-npm-package.tgz", tempDir.path)
  await builder.exec("tar", [
    "-xzf",
    path.join(tempDir.path, "cg3-npm-package.tgz"),
    "-C",
    tempDir.path,
  ])
  const pkgDir = path.join(tempDir.path, "cg3")

  const manifest = JSON.parse(
    await Deno.readTextFile(path.join(pkgDir, "package.json")),
  )
  if (`v${manifest.version}` !== tag) {
    throw new Error(
      `tag ${tag} does not name the package version ${manifest.version}`,
    )
  }

  // npm never packs .npmrc, so the token stays out of the published package.
  const token = (await builder.secrets("npm/token")).get("npm/token")
  await Deno.writeTextFile(
    path.join(pkgDir, ".npmrc"),
    `//registry.npmjs.org/:_authToken=${token}\n`,
  )
  await builder.exec("npm", ["publish", "--access", "public"], { cwd: pkgDir })
}

/**
 * Publishes the divvun-cg3 sdist and every wheel in one upload, on a version
 * tag only, and only when there is a file for each and every one names the
 * tag's version. Needs
 * the `pypiToken` secret, an account-wide PyPI token: the first release creates
 * the divvun-cg3 project under its account.
 */
export async function runCg3RsPypiPublish() {
  const tag = builder.env.tag
  if (!tag?.match(/^v/)) {
    throw new Error("cg3-rs-pypi-publish requires a version tag")
  }
  const version = tag.slice(1)

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(`${PYTHON_DIST}/*`, tempDir.path)
  const dist = path.join(tempDir.path, PYTHON_DIST)
  const files: string[] = []
  for await (const entry of Deno.readDir(dist)) {
    files.push(path.join(dist, entry.name))
  }
  const named = new RegExp(
    `^divvun_cg3-${version.replaceAll(".", "\\.")}(-.+\\.whl|\\.tar\\.gz)$`,
  )
  const stray = files.filter((f) => !named.test(path.basename(f)))
  if (stray.length > 0 || files.length !== WHEELS.length + 1) {
    throw new Error(
      `expected the sdist and ${WHEELS.length} wheels, all at ${version}: ${
        files.map((f) => path.basename(f)).join(", ")
      }`,
    )
  }

  const token = (await builder.secrets("pypiToken")).get("pypiToken")
  await builder.exec("uv", ["publish", ...files], {
    env: { UV_PUBLISH_TOKEN: token },
  })
}
