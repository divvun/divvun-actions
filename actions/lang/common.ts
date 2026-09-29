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

/**
 * The lang-deps step's sibling dependency repos (giella-core, declared
 * shared-* and lang-*), built, as `prepareLangDependencies` packed them.
 */
export const DEPENDENCY_SNAPSHOT = "workspace-deps.tar.zst"

/**
 * The lang-deps step: decide and build this build's dependency repos, and
 * upload them for every other step. See `prepareLangDependencies`.
 * giella-core's configure requires GiellaLTLexTools, hence the toolchain.
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
 * Download the lang-deps step's dependency snapshot and unpack it over this
 * checkout's siblings (or into `opts.destDir`), so this step builds and tests
 * against exactly the dependency commits the rest of the build uses, with no
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

/**
 * Everything a giella build or test step needs beside the checkout: the
 * toolchain, the lang-deps step's dependency repos and the corpus repos at
 * the commits it recorded.
 */
export async function setupLangDependencies(): Promise<void> {
  await setupLangToolchain()
  await downloadAndRestoreDependencySnapshot()
  await checkoutCorpusRepos()
}

/**
 * A build step's whole checkout, built and configured, for the steps that
 * continue from it: speller-build's for grammar-build, speller-test and
 * proofing-build; grammar-build's for grammar-test.
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
 * Built files a snapshot leaves out and uploads as artifacts of their own
 * instead: the products other steps download anyway, and too large to carry
 * twice (grammar-build's bundle.drb and .zcheck are ~600 MiB each). Restoring
 * downloads them back into place. Nothing is built from them, and a download
 * is newer than everything they are built from, so make leaves them be.
 */
const SNAPSHOT_ARTIFACTS: Record<WorkspaceSnapshot, string[]> = {
  speller: [],
  grammar: [
    "build/tools/grammarcheckers/*.drb",
    "build/tools/grammarcheckers/*.zcheck",
  ],
}

/** The largest directories under build/, so the snapshot's size is explained. */
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
 * Pack this checkout (source + build dir, mtimes preserved, without .git) as
 * `snapshot`, upload it with the artifacts it leaves out
 * (`SNAPSHOT_ARTIFACTS`), and record where it was built: configure wrote that
 * absolute path into the Makefiles and scripts, and `restoreBuiltWorkspace`
 * makes it lead to wherever the snapshot is unpacked. Excluding .git keeps the
 * archive smaller and avoids conflicts with the downstream step's own
 * checkout.
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
  // Modification times are restored, so make sees build artifacts as newer
  // than sources and will not attempt to recompile anything.
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
 * Make the checkout path a snapshot was built at lead to this one.
 *
 * The path differs between agents only in the agent's name
 * (/buildkite/builds/<agent>/<org>/<pipeline>/<repo>). Its parent, which also
 * holds giella-core and the other sibling repos, becomes a symlink to this
 * checkout's parent, so every absolute path configure recorded reaches the
 * same files here. Re-running configure instead would rewrite every file it
 * generates, and make would rebuild whatever depends on them (the spellers'
 * index.xml, and so every .zhfst). Each agent runs in its own container, so
 * the link is seen by nothing but this job and later jobs on this agent,
 * which replace it.
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
 * Restore a built + configured workspace on a fresh agent, ready to `make`
 * without rebuilding anything: download `snapshot`, set up the build's
 * dependency and corpus repos, and make the checkout path it was built at
 * lead here (see `reachBuiltCheckout`). All snapshots keep their build-machine
 * mtimes and nothing is regenerated, so make treats the built artifacts as up
 * to date.
 *
 * A snapshot that recorded no checkout path (made before that was recorded)
 * is configured again with the flags in `configureFlagsMetadataKey` instead,
 * as it used to be; make then repacks the spellers.
 *
 * Shared by the test steps and the proofing-build step.
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
