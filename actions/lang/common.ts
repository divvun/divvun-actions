import * as path from "@std/path"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

const GTLEXTOOLS_SPEC = "git+https://github.com/divvun/GiellaLTLexTools"

/** Where docker/tools/{hfst,cg3}.ts stage the Rust binaries in the images. */
const DIVVUN_RUST_BIN = "/opt/divvun/bin"

/**
 * Repos switched over to the Rust hfst/cg3. That directory is deliberately
 * left off PATH in the images so the apt C++ tools stay the default; listing a
 * repo here opts its giella build and test steps into the Rust toolchain.
 *
 * `pipelineLang()` reads the same predicate to tag the affected step labels
 * with "(Rust)", so a glance at the build tells you which toolchain ran.
 */
export const RUST_TOOLCHAIN_REPOS = ["lang-kal", "lang-sme"]

export function usesRustToolchain(): boolean {
  return RUST_TOOLCHAIN_REPOS.includes(builder.env.repoName)
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

async function gitPull(repoPath: string): Promise<boolean> {
  const proc = new Deno.Command("git", {
    args: ["pull"],
    cwd: repoPath,
  }).spawn()
  return (await proc.status).code === 0
}

/**
 * Update a build-dependency checkout in place.
 *
 * giella-core's `make` rewrites tracked files (docs/badgedata/version.json), so
 * on an agent that has built before, a plain `git pull` aborts with "Your local
 * changes would be overwritten by merge" and every subsequent build fails.
 * These checkouts are disposable build inputs rather than somewhere work is
 * authored, so discard the modifications and pull again. A pull that fails for
 * any other reason (diverged branch, network) still throws untouched.
 */
export async function updateDependencyRepo(
  repoPath: string,
  name: string,
): Promise<void> {
  logger.info(`Updating ${name}...`)
  if (await gitPull(repoPath)) {
    return
  }

  const status = await new Deno.Command("git", {
    args: ["status", "--porcelain", "--untracked-files=no"],
    cwd: repoPath,
  }).output()
  const dirty = new TextDecoder().decode(status.stdout).trim()
  if (dirty === "") {
    throw new Error(`Failed to update ${name}`)
  }

  logger.warning(
    `Discarding local changes in ${name} and retrying:\n${dirty}`,
  )
  const restore = new Deno.Command("git", {
    args: ["checkout", "--", "."],
    cwd: repoPath,
  }).spawn()
  if ((await restore.status).code !== 0) {
    throw new Error(`Failed to discard local changes in ${name}`)
  }

  if (!(await gitPull(repoPath))) {
    throw new Error(`Failed to update ${name}`)
  }
}

export async function setupGiellaCoreDependencies(): Promise<void> {
  // Prepend before anything else runs: giella-core's make below, and every
  // autogen/configure/make in the callers, are spawned without an explicit
  // env and so inherit this process's PATH.
  if (usesRustToolchain()) {
    logger.info(`Using Rust hfst/cg3 from ${DIVVUN_RUST_BIN}`)
    builder.addPath(DIVVUN_RUST_BIN)
  }

  await ensureGtlextoolsVenv()

  // Check ../giella-core and ../shared-mul
  const giellaCorePath = path.join(Deno.cwd(), "..", "giella-core")
  if (await fs.exists(giellaCorePath)) {
    await updateDependencyRepo(giellaCorePath, "giella-core")

    logger.info("Building giella-core...")
    const proc2 = new Deno.Command("make", { cwd: giellaCorePath }).spawn()
    const status2 = await proc2.status
    if (status2.code !== 0) {
      throw new Error(`Failed to build giella-core: ${status2.code}`)
    }
  }

  const sharedMulPath = path.join(Deno.cwd(), "..", "shared-mul")
  if (await fs.exists(sharedMulPath)) {
    await updateDependencyRepo(sharedMulPath, "shared-mul")
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

export async function runLangTests(opts: {
  metadataKey: string
  label: string
}) {
  const { metadataKey, label } = opts

  logger.info(`Downloading ${label} workspace snapshot`)
  await downloadAndExtractSpellerSnapshot()

  await setupGiellaCoreDependencies()

  // Re-run configure (not autogen) to regenerate Makefiles with the correct
  // absolute paths for this agent. The compiled artifacts already have their
  // original mtimes from the build machine, so make will not recompile them.
  const configureFlags = await builder.metadata(metadataKey)
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

  logger.info(`Running ${label} tests`)

  // Run make check in the build directory
  const proc = new Deno.Command("bash", {
    args: ["-c", "make -j$(nproc) check"],
    cwd: path.join(Deno.cwd(), "build"),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()

  const status = await proc.status

  // Exit with the actual test exit code - soft_fail in pipeline config handles continuation
  if (status.code !== 0) {
    logger.error(`${label} tests failed with exit code ${status.code}`)
    Deno.exit(status.code)
  }

  logger.info(`${label} tests passed`)
}
