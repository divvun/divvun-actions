import * as path from "@std/path"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import {
  ensureLangDependencyRepos,
  restoreLangDependencyRepos,
} from "./deps.ts"

const GTLEXTOOLS_SPEC = "git+ssh://git@github.com/divvun/GiellaLTLexTools"

/** Where docker/tools/{hfst,cg3}.ts stage the Rust binaries in the images. */
const DIVVUN_RUST_BIN = "/opt/divvun/bin"

/**
 * Repos kept on the apt C++ hfst/cg3. Every other repo's giella build and test
 * steps put the Rust toolchain first on PATH; the images stage it off PATH so
 * the C++ tools are still there for the repos listed here.
 *
 * `pipelineLang()` reads the same predicate to tag the affected step labels
 * with "(C++)", so a glance at the build tells you which toolchain ran.
 */
export const CPP_TOOLCHAIN_REPOS: string[] = []

export function usesRustToolchain(): boolean {
  return !CPP_TOOLCHAIN_REPOS.includes(builder.env.repoName)
}

async function ensureGtlextoolsVenv(): Promise<void> {
  const cacheRoot = Deno.env.get("BUILDKITE_PLUGIN_FS_CACHE_FOLDER") ??
    path.join(
      Deno.env.get("HOME") ?? "/tmp",
      ".cache",
      "divvun-actions",
    )
  const venvPath = path.join(cacheRoot, "gtlextools-venv")
  const venvBin = path.join(venvPath, "bin")

  if (!(await fs.exists(venvPath))) {
    logger.info(`Creating gtlextools venv at ${venvPath}`)
    await fs.ensureDir(cacheRoot)
    const venv = new Deno.Command("uv", {
      args: ["venv", venvPath],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn()
    const code = (await venv.status).code
    if (code !== 0) {
      throw new Error(`uv venv failed with exit code ${code}`)
    }
  }

  logger.info("Refreshing GiellaLTLexTools in cached venv")
  const install = new Deno.Command("uv", {
    args: [
      "pip",
      "install",
      "--upgrade",
      "--python",
      path.join(venvBin, "python"),
      GTLEXTOOLS_SPEC,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const code = (await install.status).code
  if (code !== 0) {
    throw new Error(
      `uv pip install GiellaLTLexTools failed with exit code ${code}`,
    )
  }

  builder.addPath(venvBin)
}

/**
 * The tools a giella build or test step runs, without the sibling repos: the
 * Rust hfst/cg3 on PATH for the repos using them, and GiellaLTLexTools.
 */
export async function setupLangToolchain(): Promise<void> {
  // Prepend before anything else runs: giella-core's make, and every
  // autogen/configure/make in the callers, are spawned without an explicit
  // env and so inherit this process's PATH.
  if (usesRustToolchain()) {
    logger.info(`Using Rust hfst/cg3 from ${DIVVUN_RUST_BIN}`)
    builder.addPath(DIVVUN_RUST_BIN)
  }

  await ensureGtlextoolsVenv()
}

/** Toolchain plus freshly resolved sibling repos, for the steps that build
 * from scratch. */
export async function setupGiellaCoreDependencies(): Promise<void> {
  await setupLangToolchain()

  await ensureLangDependencyRepos()
}

/**
 * The speller-build step's sibling dependency repos (giella-core, declared
 * shared-*), built, as `packLangDependencyRepos` packed them. A separate
 * artifact from the workspace snapshot so a step that needs only the
 * dependencies doesn't download the whole built tree.
 */
export const DEPENDENCY_SNAPSHOT = "workspace-deps.tar.gz"

/**
 * Download the speller-build step's dependency snapshot and unpack it over
 * this checkout's siblings (or into `opts.destDir`), so this step builds and
 * tests against exactly the dependency commits speller-build used, with no
 * git network access of its own.
 */
export async function downloadAndRestoreDependencySnapshot(
  opts?: { destDir?: string; repos?: string[] },
): Promise<void> {
  const workDir = (await makeTempDir({ prefix: "workspace-deps-" })).path
  try {
    await builder.downloadArtifacts(DEPENDENCY_SNAPSHOT, workDir)
    await restoreLangDependencyRepos(
      path.join(workDir, DEPENDENCY_SNAPSHOT),
      opts,
    )
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}

export async function downloadAndExtractSpellerSnapshot(): Promise<void> {
  // Download the workspace snapshot produced by the speller-build step and
  // extract it. tar -p restores mtimes, so make sees build artifacts as newer
  // than sources and will not attempt to recompile anything.
  await builder.downloadArtifacts("workspace-speller.tar.gz", ".")
  logger.info("Extracting speller workspace snapshot")
  const extractProc = new Deno.Command("tar", {
    args: ["-xpf", "workspace-speller.tar.gz"],
    cwd: Deno.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const extractStatus = await extractProc.status
  if (extractStatus.code !== 0) {
    throw new Error(
      `tar extraction failed with exit code ${extractStatus.code}`,
    )
  }
  await Deno.remove("workspace-speller.tar.gz")
}

/**
 * Restore the built + configured workspace on a fresh agent: download the
 * speller-build workspace and dependency snapshots, and re-run `configure`
 * (not autogen) so the Makefiles carry this agent's absolute paths. Both
 * snapshots keep their build-machine mtimes, so make treats the compiled
 * artifacts as up to date and recompiles nothing.
 *
 * Shared by the test steps and the proofing-build step, which all need a
 * ready-to-`make` tree without a full rebuild.
 */
export async function restoreBuiltWorkspace(
  configureFlagsMetadataKey: string,
): Promise<void> {
  await downloadAndExtractSpellerSnapshot()

  await setupLangToolchain()
  await downloadAndRestoreDependencySnapshot()

  const configureFlags = await builder.metadata(configureFlagsMetadataKey)
  logger.info("Running configure")
  const configureProc = new Deno.Command("bash", {
    args: ["-c", `../configure ${configureFlags}`],
    cwd: path.join(Deno.cwd(), "build"),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const configureStatus = await configureProc.status
  if (configureStatus.code !== 0) {
    throw new Error(`configure failed with exit code ${configureStatus.code}`)
  }
}

export async function runLangTests(opts: {
  metadataKey: string
  label: string
}) {
  const { metadataKey, label } = opts

  logger.info(`Downloading ${label} workspace snapshot`)
  await restoreBuiltWorkspace(metadataKey)

  logger.info(`Running ${label} tests`)

  // Run make check in the build directory
  const proc = new Deno.Command("bash", {
    args: ["-c", "make -j$(nproc) check"],
    cwd: path.join(Deno.cwd(), "build"),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()

  const status = await proc.status

  // `make check` writes the per-suite lemma-test JSON into docs/testlogs/
  // (gtlemmatest/gtspelltest -J). Hand it to the docs-publish step, which
  // turns it into the testlogs manifest on the rolling release. Upload before
  // the exit-on-failure below: failing tests are exactly when these logs
  // matter. Only the speller run does this, so grammar tests don't upload a
  // second identical copy.
  if (label === "speller") {
    try {
      await builder.uploadArtifacts("docs/testlogs/*-lemmas.json")
    } catch (e) {
      logger.warning(`Failed to upload testlogs: ${e}`)
    }
    // Same for the speller accuracy reports: suggestion-quality.sh and the
    // test-speller-variant-*.sh scripts write docs/typosreport/report.json /
    // report-<code>.json with the full typos-*-generated.tsv data and the
    // speller's config.json — exactly what a local `make check` reports.
    try {
      await builder.uploadArtifacts("docs/typosreport/*.json")
    } catch (e) {
      logger.warning(`Failed to upload typosreport: ${e}`)
    }
  }

  // Exit with the actual test exit code - soft_fail in pipeline config handles continuation
  if (status.code !== 0) {
    logger.error(`${label} tests failed with exit code ${status.code}`)
    Deno.exit(status.code)
  }

  logger.info(`${label} tests passed`)
}
