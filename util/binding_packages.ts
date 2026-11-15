/**
 * The steps and publish actions for a Rust library's language packages: an
 * npm package built from a wasm-bindgen crate, a Python package built from a
 * pyo3 crate with maturin, and a Swift package built from UniFFI crates into
 * an XCFramework and published to Pahkat's SwiftPM registry. Each package is
 * versioned on its own, in its binding crate, and released from its own tag:
 * `wasm/v<version>`, `python/v<version>` or `swift/v<version>`.
 */
import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import type { CommandStep } from "~/builder/pipeline.ts"
import { publishRegistryPackage } from "~/util/pahkat.ts"
import { makeTempDir } from "~/util/temp.ts"

/** How a pipeline makes a step, adding its plugins. */
export type Command = (input: CommandStep) => CommandStep

/** A release of one of the packages, from its own tag. */
export type PackageRelease = {
  package: "wasm" | "python" | "swift"
  version: string
}

export function packageReleaseOf(
  tag: string | undefined,
): PackageRelease | null {
  const match = tag?.match(/^(wasm|python|swift)\/v(\d.*)$/)
  if (!match) return null
  return { package: match[1] as PackageRelease["package"], version: match[2] }
}

// binaryen, for the wasm-opt the packages' js/build.mjs runs.
const BINARYEN = "version_123"

/** An npm package built from a wasm-bindgen crate. */
export type WasmPackage = {
  /** The binding crate, whose Cargo.toml pins wasm-bindgen exactly. */
  crate: string
  /** The package's directory under js/, which is packed whole. */
  packageDir: string
  /** The npm package's name, for labels and messages. */
  name: string
  /** What checks the package between installing the tools and packing it. */
  checks: string[]
}

function npmTarball(pkg: WasmPackage): string {
  return `${pkg.packageDir}-npm-package.tgz`
}

/**
 * The wasm-bindgen CLI writes glue for its own version of the ABI, so it must
 * be the exact version the crate pins. Read the pin rather than repeat it.
 */
function wasmBindgenVersion(crate: string): string {
  // deno-lint-ignore no-explicit-any
  const manifest = toml.parse(
    Deno.readTextFileSync(`${crate}/Cargo.toml`),
  ) as any
  const pin = manifest?.dependencies?.["wasm-bindgen"]
  const version = typeof pin === "string" ? pin.replace(/^=/, "") : undefined
  if (!version) {
    throw new Error(`${crate}/Cargo.toml does not pin wasm-bindgen`)
  }
  return version
}

/**
 * Builds the npm package and runs its checks, then uploads it for the npm
 * publish step. The image has no wasm32 target, wasm-bindgen or wasm-opt, so
 * the step installs them first.
 */
export function wasmPackageStep(
  command: Command,
  pkg: WasmPackage,
): CommandStep {
  const binaryen = `/tmp/binaryen-${BINARYEN}`
  return command({
    key: "wasm-package",
    label: "wasm package",
    agents: { queue: "linux" },
    command: [
      "echo '--- Installing the wasm tools'",
      "rustup target add wasm32-unknown-unknown",
      `cargo binstall -y --force wasm-bindgen-cli@${
        wasmBindgenVersion(pkg.crate)
      }`,
      `curl -sSfL https://github.com/WebAssembly/binaryen/releases/download/${BINARYEN}/binaryen-${BINARYEN}-x86_64-linux.tar.gz | tar xz -C /tmp`,
      `export PATH="${binaryen}/bin:$$PATH"`,
      ...pkg.checks,
      `tar -czf ${npmTarball(pkg)} -C js ${pkg.packageDir}`,
      `buildkite-agent artifact upload ${npmTarball(pkg)}`,
    ],
  })
}

/**
 * Publishes the npm package the wasm-package step built, only when its
 * package.json names `version`. Needs the `npm/token` secret: an npm token
 * allowed to publish to the @divvun scope.
 */
export async function publishToNpm(pkg: WasmPackage, version: string) {
  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(npmTarball(pkg), tempDir.path)
  await builder.exec("tar", [
    "-xzf",
    path.join(tempDir.path, npmTarball(pkg)),
    "-C",
    tempDir.path,
  ])
  const pkgDir = path.join(tempDir.path, pkg.packageDir)

  const manifest = JSON.parse(
    await Deno.readTextFile(path.join(pkgDir, "package.json")),
  )
  if (manifest.version !== version) {
    throw new Error(
      `${pkg.name} is at ${manifest.version}, not the tag's ${version}`,
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

// maturin builds the wheels from python/. 1.9.4 is the first to set
// PYO3_BUILD_EXTENSION_MODULE, which pyo3 0.30 needs; the zig extra brings the
// linker the Linux wheels are made with.
const MATURIN = "maturin[zig]>=1.9.4,<2"

/** One wheel: an abi3 wheel for CPython 3.11 and later. */
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

/** A Python package built from a pyo3 crate with maturin, from python/. */
export type PythonPackage = {
  /** The distribution's name as wheel file names spell it: `divvun_cg3`. */
  distribution: string
  /** The variable the package's tests read the wheel under test from. */
  wheelEnv: string
  /** What every wheel build needs in its environment. */
  buildEnv?: Record<string, string>
  /** The fixtures the package's tests read, built once on a linux agent. */
  fixtures?: TestFixtures
}

function wheelKey(wheel: Wheel): string {
  return `python-wheel-${wheel.target}`
}

/**
 * Fixtures a package's test suites read. A linux agent builds them once with
 * `build <directory>`, and each test step, of any of the library's packages,
 * reads that directory from the variable `env`, so a test agent compiles
 * nothing itself.
 */
export type TestFixtures = { build: string; env: string }

const FIXTURES_KEY = "test-fixtures"
const FIXTURES_DIR = "dist/test-fixtures"
const FIXTURES_TARBALL = "test-fixtures.tgz"

/**
 * The step that builds `fixtures`. pythonPackageSteps includes it when its
 * package has fixtures; a pipeline that builds another package reading them
 * without the Python package adds it itself.
 */
export function fixturesStep(
  command: Command,
  fixtures: TestFixtures,
): CommandStep {
  return command({
    key: FIXTURES_KEY,
    label: ":test_tube: test fixtures",
    agents: { queue: "linux" },
    command: [
      `${fixtures.build} ${FIXTURES_DIR}`,
      `tar -czf ${FIXTURES_TARBALL} ${FIXTURES_DIR}`,
      `buildkite-agent artifact upload ${FIXTURES_TARBALL}`,
    ],
  })
}

function sdistStep(command: Command): CommandStep {
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

function wheelStep(
  command: Command,
  pkg: PythonPackage,
  wheel: Wheel,
): CommandStep {
  const zig = wheel.platform ? ` --zig --compatibility ${wheel.platform}` : ""
  return command({
    key: wheelKey(wheel),
    label: `:python: ${wheel.target}`,
    agents: { queue: wheel.queue },
    ...(pkg.buildEnv ? { env: pkg.buildEnv } : {}),
    command: [
      `rustup target add ${wheel.target}`,
      `(cd python && uvx --from '${MATURIN}' maturin build --release --locked --target ${wheel.target}${zig} --out ../${PYTHON_DIST})`,
      `buildkite-agent artifact upload '${PYTHON_DIST}/*.whl'`,
    ],
  })
}

/** The commands that fetch `fixtures` into a test step and name them in its environment. */
function fixturesDownload(fixtures: TestFixtures): string[] {
  return [
    `buildkite-agent artifact download --step ${FIXTURES_KEY} ${FIXTURES_TARBALL} .`,
    `tar -xzf ${FIXTURES_TARBALL}`,
    `export ${fixtures.env}="$$PWD/${FIXTURES_DIR}"`,
  ]
}

/**
 * Installs the wheel `wheel`'s step built into a fresh CPython 3.11, the oldest
 * the abi3 wheels serve, and runs the package's suite in python/tests against
 * it, with the wheel named in `pkg.wheelEnv` so the package tests inspect it.
 */
function wheelTestStep(
  command: Command,
  pkg: PythonPackage,
  wheel: Wheel,
): CommandStep {
  const venv = `/tmp/${pkg.distribution.replaceAll("_", "-")}-test`
  const wheels = `${PYTHON_DIST}/*.whl`
  const fixtures = pkg.fixtures ? fixturesDownload(pkg.fixtures) : []
  return command({
    key: `python-test-${wheel.target}`,
    label: `:python: test ${wheel.target}`,
    agents: { queue: wheel.queue },
    depends_on: pkg.fixtures
      ? [wheelKey(wheel), FIXTURES_KEY]
      : wheelKey(wheel),
    command: [
      `buildkite-agent artifact download --step ${
        wheelKey(wheel)
      } '${wheels}' .`,
      ...fixtures,
      `rm -rf ${venv} && uv venv --python 3.11 ${venv}`,
      `uv pip install --python ${venv}/bin/python ${wheels} pytest`,
      // pytest runs in python/, so the wheel is named from the checkout root.
      `export ${pkg.wheelEnv}="$$PWD/$$(ls ${wheels})"`,
      `(cd python && ${venv}/bin/pytest -q -rs -p no:cacheprovider)`,
    ],
  })
}

/**
 * The sdist, a step per wheel, and a step testing each wheel its agent can
 * run. Each uploads what it built; the PyPI publish step downloads them all
 * and uploads them in one go.
 */
export function pythonPackageSteps(
  command: Command,
  pkg: PythonPackage,
): CommandStep[] {
  return [
    sdistStep(command),
    ...WHEELS.map((wheel) => wheelStep(command, pkg, wheel)),
    ...(pkg.fixtures ? [fixturesStep(command, pkg.fixtures)] : []),
    ...WHEELS.filter((w) => w.tested).map((wheel) =>
      wheelTestStep(command, pkg, wheel)
    ),
  ]
}

/**
 * Publishes the sdist and every wheel in one upload, only when there is a file
 * for each and every one names `version`. Needs the `pypiToken` secret, an
 * account-wide PyPI token: a package's first release creates its project
 * under that account.
 */
export async function publishToPypi(pkg: PythonPackage, version: string) {
  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(`${PYTHON_DIST}/*`, tempDir.path)
  const dist = path.join(tempDir.path, PYTHON_DIST)
  const files: string[] = []
  for await (const entry of Deno.readDir(dist)) {
    files.push(path.join(dist, entry.name))
  }
  const named = new RegExp(
    `^${pkg.distribution}-${
      version.replaceAll(".", "\\.")
    }(-.+\\.whl|\\.tar\\.gz)$`,
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

/**
 * A Swift package published to Pahkat's SwiftPM registry as a source
 * archive, `swift package archive-source`'s zip of its manifest, its sources
 * and its XCFramework, beside a `package-metadata.json`.
 */
export type SwiftPackage = {
  /** The registry scope it is published in: `divvun` for `divvun.<name>`. */
  scope: string
  /** Its name in its identifier, and in its archive's name, `<name>-<version>.zip`. */
  name: string
  /** The Rust targets of the XCFramework's slices, which the agent installs. */
  targets: string[]
  /**
   * What builds the archive and the XCFramework and tests the package, on
   * macOS and on an iOS simulator, after the targets are installed.
   */
  checks: string[]
  /** The directory the checks leave the archive and `package-metadata.json` in. */
  release: string
  /**
   * The fixtures the package's tests read, when a linux agent builds them,
   * named in the environment before the checks run, and as
   * `TEST_RUNNER_<env>` too, which `xcodebuild test` passes to the tests it
   * runs on a simulator.
   */
  fixtures?: TestFixtures
}

function swiftArtifact(pkg: SwiftPackage): string {
  return `${pkg.name}-swift-package.tgz`
}

/**
 * Builds the Swift package's archive and runs its checks on a macOS agent,
 * which has Xcode and the simulators, then uploads the archive and its
 * `package-metadata.json` for the publish step.
 */
export function swiftPackageStep(
  command: Command,
  pkg: SwiftPackage,
): CommandStep {
  const fixtures = pkg.fixtures
    ? [
      "echo '--- Fetching the test fixtures'",
      ...fixturesDownload(pkg.fixtures),
      `export TEST_RUNNER_${pkg.fixtures.env}="$$${pkg.fixtures.env}"`,
    ]
    : []
  return command({
    key: "swift-package",
    label: ":swift: Swift package",
    agents: { queue: "macos" },
    ...(pkg.fixtures ? { depends_on: FIXTURES_KEY } : {}),
    command: [
      "echo '--- Installing the Apple targets'",
      `rustup target add ${pkg.targets.join(" ")}`,
      ...fixtures,
      ...pkg.checks,
      `(cd ${pkg.release} && tar -czf "$$OLDPWD/${
        swiftArtifact(pkg)
      }" ${pkg.name}-*.zip package-metadata.json)`,
      `buildkite-agent artifact upload ${swiftArtifact(pkg)}`,
    ],
  })
}

/**
 * Publishes the Swift package the swift-package step built to Pahkat's
 * SwiftPM registry, from the tag being built, only when its archive is
 * `<name>-<version>.zip`: attested with the Swift registry's CI key in the
 * namespace `<scope>` and uploaded as that namespace. The registry signs it
 * at commit.
 */
export async function publishToSwiftRegistry(
  pkg: SwiftPackage,
  version: string,
) {
  const tag = builder.env.tag
  if (tag == null) {
    throw new Error(`${pkg.scope}.${pkg.name} is published from a tag only`)
  }
  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(swiftArtifact(pkg), tempDir.path)
  const dir = path.join(tempDir.path, "release")
  await Deno.mkdir(dir)
  await builder.exec("tar", [
    "-xzf",
    path.join(tempDir.path, swiftArtifact(pkg)),
    "-C",
    dir,
  ])
  const archive = `${pkg.name}-${version}.zip`
  const files: string[] = []
  for await (const entry of Deno.readDir(dir)) files.push(entry.name)
  if (!files.includes(archive)) {
    throw new Error(
      `${pkg.scope}.${pkg.name} was built as ${
        files.join(", ")
      }, not at the tag's ${version}`,
    )
  }
  await publishRegistryPackage({
    module: "swift",
    namespace: pkg.scope,
    dir,
    tag,
  })
}
