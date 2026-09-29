import * as path from "@std/path"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { createTarZst, extractTarball } from "~/util/tarball.ts"
import { makeTempDir } from "~/util/temp.ts"
import {
  checkoutCorpusRepos,
  prepareLangDependencies,
  restoreLangDependencyRepos,
} from "./deps.ts"
import { globFiles } from "~/util/glob.ts"

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

/** The lang-deps step's built dependency repos (`prepareLangDependencies`). */
export const DEPENDENCY_SNAPSHOT = "workspace-deps.tar.zst"

/**
 * The lang-deps step. The toolchain is for giella-core's configure, which
 * requires GiellaLTLexTools.
 */
export async function langDeps(): Promise<void> {
  await setupLangToolchain()
  const workDir = (await makeTempDir({ prefix: "workspace-deps-" })).path
  try {
    await prepareLangDependencies(path.join(workDir, DEPENDENCY_SNAPSHOT))
    await builder.uploadArtifacts(DEPENDENCY_SNAPSHOT, { cwd: workDir })
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}

/**
 * Unpack the lang-deps step's dependency snapshot over this checkout's
 * siblings (or into `opts.destDir`).
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

export async function setupLangDependencies(): Promise<void> {
  await setupLangToolchain()
  await downloadAndRestoreDependencySnapshot()
  await checkoutCorpusRepos()
}

/**
 * A built checkout: speller-build's, for grammar-build, speller-test and
 * proofing-build; grammar-build's, for grammar-test.
 */
export type WorkspaceSnapshot = "speller" | "grammar"

function snapshotArchive(snapshot: WorkspaceSnapshot): string {
  return `workspace-${snapshot}.tar.zst`
}

/** Build metadata key: the absolute checkout path the snapshot was built in. */
function snapshotCheckoutMetadata(snapshot: WorkspaceSnapshot): string {
  return `workspace-${snapshot}-checkout`
}

/**
 * Built files left out of a snapshot and uploaded separately: other steps
 * download them anyway, and they are large (~600 MiB each). Once downloaded
 * they are newer than their inputs, so make leaves them be.
 */
const SNAPSHOT_ARTIFACTS: Record<WorkspaceSnapshot, string[]> = {
  speller: [],
  grammar: [
    "build/tools/grammarcheckers/*.drb",
    "build/tools/grammarcheckers/*.zcheck",
  ],
}

async function logBuildDirSizes(): Promise<void> {
  const du = await new Deno.Command("bash", {
    args: ["-c", "du -m -d 3 build 2>/dev/null | sort -rn | head -n 12"],
    stdout: "piped",
  }).output()
  logger.info(
    `Largest build directories (MiB):\n${new TextDecoder().decode(du.stdout)}`,
  )
}

/**
 * Pack and upload this checkout (without .git), and record where it was
 * built: configure wrote that absolute path into the Makefiles, and
 * `restoreBuiltWorkspace` has to reach it.
 */
export async function uploadWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  const archive = snapshotArchive(snapshot)
  const artifacts = SNAPSHOT_ARTIFACTS[snapshot]
  logger.info(`Creating ${snapshot} workspace snapshot`)
  await logBuildDirSizes()
  await createTarZst(`../${archive}`, ["."], {
    cwd: Deno.cwd(),
    exclude: ["./.git", ...artifacts.map((glob) => `./${glob}`)],
  })
  await builder.setMetadata(snapshotCheckoutMetadata(snapshot), Deno.cwd())
  await builder.uploadArtifacts(archive, {
    cwd: path.resolve(Deno.cwd(), ".."),
  })
  for (const glob of artifacts) {
    await builder.uploadArtifacts(glob)
  }
}

export async function downloadAndExtractWorkspaceSnapshot(
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  // Restored mtimes keep make from rebuilding anything.
  const archive = snapshotArchive(snapshot)
  await builder.downloadArtifacts(archive, ".")
  logger.info(`Extracting ${snapshot} workspace snapshot`)
  await extractTarball(archive, { cwd: Deno.cwd() })
  await Deno.remove(archive)
  for (const glob of SNAPSHOT_ARTIFACTS[snapshot]) {
    await builder.downloadArtifacts(glob, ".")
  }
}

/**
 * Make the checkout path a snapshot was built at lead here, by symlinking its
 * parent (which also holds the sibling repos) to this checkout's parent. The
 * paths differ between agents only in the agent's name. Re-running configure
 * instead would regenerate files that every .zhfst depends on. Each agent is
 * its own container, so only this agent's jobs see the link.
 */
async function reachBuiltCheckout(builtAt: string): Promise<void> {
  const here = Deno.cwd()
  if (builtAt === here) {
    logger.info(`Built at this same path (${here})`)
    return
  }
  if (path.basename(builtAt) !== path.basename(here)) {
    throw new Error(
      `The snapshot was built in ${builtAt}, whose checkout is not named ` +
        `like this one (${here}), so its sibling paths would not match`,
    )
  }
  const builtParent = path.dirname(builtAt)
  const existing = await Deno.lstat(builtParent).catch(() => null)
  if (existing?.isSymlink) {
    await Deno.remove(builtParent)
  } else if (existing) {
    throw new Error(
      `${builtParent} exists and is not a symlink; refusing to replace it ` +
        `to reach this checkout from where the snapshot was built`,
    )
  }
  await fs.ensureDir(path.dirname(builtParent))
  await Deno.symlink(path.dirname(here), builtParent)
  logger.info(`Linked ${builtParent} -> ${path.dirname(here)}`)
}

/**
 * Restore `snapshot` and the build's dependency and corpus repos, ready to
 * `make` without rebuilding anything. A snapshot that recorded no checkout
 * path is configured again instead, which repacks the spellers.
 */
export async function restoreBuiltWorkspace(
  snapshot: WorkspaceSnapshot,
  configureFlagsMetadataKey: string,
): Promise<void> {
  await downloadAndExtractWorkspaceSnapshot(snapshot)

  await setupLangDependencies()

  const builtAt = await builder.metadata(snapshotCheckoutMetadata(snapshot))
    .then((value) => value.trim())
    .catch(() => undefined)
  if (builtAt) {
    await reachBuiltCheckout(builtAt)
    return
  }

  const configureFlags = await builder.metadata(configureFlagsMetadataKey)
  logger.warning(
    `The ${snapshot} snapshot did not record where it was built; running ` +
      `configure, which will make make repack the spellers`,
  )
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

/** Size and mtime of each speller archive in the build tree, by path. */
async function spellerArchives(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const file of await globFiles("build/tools/spellcheckers/*.zhfst")) {
    const stat = await Deno.stat(file)
    out.set(file, `${stat.size} ${stat.mtime?.getTime()}`)
  }
  return out
}

/** Archives added, removed or rewritten between two `spellerArchives` calls. */
function changedArchives(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths]
    .filter((p) => before.get(p) !== after.get(p))
    .map((p) => path.basename(p))
}

export async function runLangTests(opts: {
  snapshot: WorkspaceSnapshot
  metadataKey: string
  label: string
}) {
  const { snapshot, metadataKey, label } = opts

  logger.info(`Downloading ${label} workspace snapshot`)
  await restoreBuiltWorkspace(snapshot, metadataKey)

  logger.info(`Running ${label} tests`)

  // `make check` builds `all` first, so anything it finds out of date is
  // rebuilt before it is tested. The spellers must come through untouched:
  // results for a rebuilt one describe a speller that was never shipped.
  const shipped = await spellerArchives()

  // Run make check in the build directory
  const proc = new Deno.Command("bash", {
    args: ["-c", "make -j$(nproc) check"],
    cwd: path.join(Deno.cwd(), "build"),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()

  const status = await proc.status

  const rebuilt = changedArchives(shipped, await spellerArchives())
  if (rebuilt.length > 0) {
    logger.error(
      `make check rebuilt ${rebuilt.join(", ")}; its results are for a ` +
        `speller the speller-build step did not ship, so none are published`,
    )
  }

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
    if (rebuilt.length === 0) {
      try {
        await builder.uploadArtifacts("docs/typosreport/*.json")
      } catch (e) {
        logger.warning(`Failed to upload typosreport: ${e}`)
      }
    }
  }

  // Exit with the actual test exit code - soft_fail in pipeline config handles continuation
  if (status.code !== 0) {
    logger.error(`${label} tests failed with exit code ${status.code}`)
    Deno.exit(status.code)
  }
  if (rebuilt.length > 0) {
    Deno.exit(1)
  }

  logger.info(`${label} tests passed`)
}
