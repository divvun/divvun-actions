import * as path from "@std/path"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

/**
 * Sibling dependency repos for a language build.
 *
 * A language checkout builds against repos that live BESIDE it: giella-core,
 * the shared-* lexicon repos, sometimes other lang-* repos, and the speller
 * corpus repos. Which ones a language needs is not for the pipeline to know:
 * configure.ac declares the build dependencies (gt_USE_SHARED / gt_NEED_SHARED
 * lines), and the speller weighting reads ../corpus-<lang> and
 * ../corpus-<lang>-x-closed when they exist (giella-core 1.15.2+). This module
 * reads those declarations and makes the siblings present and current, so no
 * action hard-codes its own repo list.
 *
 * Only the steps that build from scratch (speller-build, tts-textproc-build,
 * the combined build) resolve these repos. speller-build then packs the build
 * dependencies it built against (`packLangDependencyRepos`) and every later
 * step unpacks that exact tree over its own siblings
 * (`restoreLangDependencyRepos`), so one build uses one set of dependency
 * commits, however many agents its steps land on.
 */

async function gitPull(repoPath: string): Promise<boolean> {
  const proc = new Deno.Command("git", {
    args: ["pull"],
    cwd: repoPath,
  }).spawn()
  return (await proc.status).code === 0
}

/**
 * Discarding local changes is only correct where a checkout is a disposable
 * build input. On CI agents it is; in local mode `..` may be a developer's
 * working tree with uncommitted work, and a build step must never eat that.
 */
function checkoutsAreDisposable(): boolean {
  return Deno.env.get("BUILDKITE") != null
}

/**
 * Update a dependency checkout in place.
 *
 * giella-core's `make` rewrites tracked files (docs/badgedata/version.json), so
 * on an agent that has built before, a plain `git pull` aborts with "Your local
 * changes would be overwritten by merge" and every subsequent build fails.
 * On CI the checkouts are disposable build inputs rather than somewhere work
 * is authored, so discard the modifications and pull again. A pull that fails
 * for any other reason (diverged branch, network) still throws untouched.
 */
export async function updateDependencyRepo(
  repoPath: string,
  name: string,
): Promise<void> {
  // A checkout with no current branch is not ours to update. Buildkite checks
  // pipelines out at a fixed commit, detached, so a sibling that is another
  // pipeline's own checkout (lang-smj beside lang-sma, on an agent that
  // builds both) looks exactly like this -- and `git pull` in it can only
  // fail with "You are not currently on a branch". Dependency clones made by
  // autogen or by this module are on a branch, so they still update.
  const head = await new Deno.Command("git", {
    args: ["symbolic-ref", "-q", "--short", "HEAD"],
    cwd: repoPath,
  }).output()
  if (head.code !== 0) {
    logger.warning(
      `${name} is checked out at a fixed commit (likely another pipeline's ` +
        `Buildkite checkout); leaving it as it is`,
    )
    return
  }

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

  if (!checkoutsAreDisposable()) {
    logger.warning(
      `${name} has local changes and cannot be pulled; leaving it as it ` +
        `is (not on CI, so it may be a working tree):\n${dirty}`,
    )
    return
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

/**
 * The sibling repos configure.ac declares as build dependencies, in
 * declaration order. `gt_USE_SHARED([smi], [shared-smi], [giella-shared-smi])`
 * names the repo in its second argument; gt_NEED_SHARED repeats a USE line to
 * add a version floor, so the two are read alike and deduplicated.
 */
export async function declaredDependencyRepos(
  langDir: string = Deno.cwd(),
): Promise<string[]> {
  const configureAc = path.join(langDir, "configure.ac")
  if (!(await fs.exists(configureAc))) {
    return []
  }
  const text = await Deno.readTextFile(configureAc)
  const repos = new Set<string>()
  const uses = text.matchAll(
    /^\s*gt_(?:USE|NEED)_SHARED\(\s*\[[^\]]*\]\s*,\s*\[([^\]]+)\]/gm,
  )
  for (const use of uses) {
    repos.add(use[1])
  }
  return [...repos]
}

/**
 * The speller corpus repos for a language: public and closed.
 *
 * An `-x-` qualifier in the repo name (lang-sjd-x-private, lang-est-x-utee)
 * is not part of the language code, so it is stripped: the corpora follow the
 * base code -- corpus-sjd exists, corpus-sjd-x-private does not.
 */
export function corpusRepos(repoName: string): string[] {
  if (!repoName.startsWith("lang-")) {
    return []
  }
  const lang = repoName.slice("lang-".length).replace(/-x-.*$/, "")
  return [`corpus-${lang}`, `corpus-${lang}-x-closed`]
}

/**
 * Clone URL for a sibling repo, derived from the language checkout's own
 * origin so it rides on whatever credential scheme (ssh key, token) fetched
 * the language repo itself. Same host, owner and scheme, different name.
 */
async function siblingCloneUrl(repoName: string): Promise<string> {
  const origin = await new Deno.Command("git", {
    args: ["remote", "get-url", "origin"],
    cwd: Deno.cwd(),
  }).output()
  const originUrl = new TextDecoder().decode(origin.stdout).trim()
  return originUrl.replace(/[^/:]+?(\.git)?$/, `${repoName}.git`)
}

async function cloneSibling(
  repoName: string,
  repoPath: string,
): Promise<boolean> {
  const url = await siblingCloneUrl(repoName)
  logger.info(`Cloning ${repoName} (shallow) from ${url}`)
  const proc = new Deno.Command("git", {
    args: ["clone", "--depth", "1", url, repoPath],
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  return (await proc.status).code === 0
}

/**
 * Log the commit a sibling checkout is actually sitting at, so a CI run can be
 * compared against another run or a developer's local checkout without
 * guessing from "Updating X..." alone (that line only says a pull was
 * attempted, not what it landed on).
 */
async function logRepoRevision(repoPath: string, name: string): Promise<void> {
  const log = await new Deno.Command("git", {
    args: ["log", "-1", "--format=%h %cI %s"],
    cwd: repoPath,
  }).output()
  const rev = new TextDecoder().decode(log.stdout).trim()
  logger.info(`${name} is at ${rev || "(unknown revision)"}`)
}

/**
 * Make the language's sibling dependency repos present and current.
 *
 * For the steps that build from scratch. Steps that continue from
 * speller-build's snapshot use `restoreLangDependencyRepos` instead.
 *
 * giella-core is cloned + bootstrapped when missing, not just updated when
 * present, rather than leaving the clone to the language's own autogen.sh:
 * `hooks/environment` gives every pipeline its own checkout parent, so a
 * pipeline's first build on an agent starts with no siblings at all, and
 * giella-core is a hard build requirement with no fallback. A failure to
 * clone or bootstrap it is fatal.
 *
 * Declared shared-* repos (configure.ac's gt_USE_SHARED / gt_NEED_SHARED) get
 * the same clone-when-missing treatment as giella-core -- but best-effort,
 * not fatal: a plain gt_USE_SHARED only downgrades to a
 * configure *warning* when the directory is absent, so a failed clone there
 * is harmless. gt_NEED_SHARED (a handful of repos, adding a pkg-config
 * version floor on top) is NOT harmless -- it hard-errors
 * ("giella-shared-mul needs to be updated and installed") if the clone
 * didn't happen and the version requirement can't be checked. Both
 * declarations look identical from here (same regex, no way to tell which
 * macro a given repo uses without parsing configure.ac's actual macro call),
 * so a failed clone/bootstrap only warns; configure right afterward is the
 * one place that actually knows whether this repo was required.
 *
 * Corpus repos are updated or shallow-cloned, and every failure is a warning:
 * the weighting falls back to the in-tree corpus by design, the closed repo
 * is private and an agent without access must still build. The build log
 * makes the outcome visible either way -- giella-core prints a CORPUS line
 * naming the repos it assembled from.
 */
export async function ensureLangDependencyRepos(opts?: {
  spellers?: boolean
}): Promise<void> {
  const spellers = opts?.spellers ?? true

  const giellaCorePath = path.join(Deno.cwd(), "..", "giella-core")
  if (await fs.exists(giellaCorePath)) {
    await updateDependencyRepo(giellaCorePath, "giella-core")
  } else {
    if (!(await cloneSibling("giella-core", giellaCorePath))) {
      throw new Error("Failed to clone giella-core")
    }
    logger.info("Bootstrapping giella-core...")
    const bootstrap = new Deno.Command("bash", {
      args: ["-c", "./autogen.sh && ./configure"],
      cwd: giellaCorePath,
    }).spawn()
    if ((await bootstrap.status).code !== 0) {
      throw new Error("Failed to bootstrap freshly cloned giella-core")
    }
  }
  await logRepoRevision(giellaCorePath, "giella-core")

  logger.info("Building giella-core...")
  const make = new Deno.Command("make", { cwd: giellaCorePath }).spawn()
  if ((await make.status).code !== 0) {
    throw new Error("Failed to build giella-core")
  }

  for (const repo of await declaredDependencyRepos()) {
    const repoPath = path.join(Deno.cwd(), "..", repo)
    if (await fs.exists(repoPath)) {
      await updateDependencyRepo(repoPath, repo)
      continue
    }

    if (!(await cloneSibling(repo, repoPath))) {
      logger.warning(
        `${repo} could not be cloned; configure will fail below if it's ` +
          "actually required (gt_NEED_SHARED), or degrade gracefully if " +
          "not (gt_USE_SHARED)",
      )
      continue
    }

    logger.info(`Bootstrapping ${repo}...`)
    const bootstrap = new Deno.Command("bash", {
      args: ["-c", "./autogen.sh && ./configure"],
      cwd: repoPath,
    }).spawn()
    if ((await bootstrap.status).code !== 0) {
      logger.warning(
        `Failed to bootstrap ${repo}; configure will fail below if it's ` +
          "actually required (gt_NEED_SHARED), or degrade gracefully if " +
          "not (gt_USE_SHARED)",
      )
    }
  }

  if (!spellers) {
    return
  }
  for (const repo of corpusRepos(builder.env.repoName)) {
    const repoPath = path.join(Deno.cwd(), "..", repo)
    if (await fs.exists(repoPath)) {
      try {
        await updateDependencyRepo(repoPath, repo)
      } catch (e) {
        logger.warning(
          `Could not update ${repo}; the speller weighting uses it as it ` +
            `is: ${e}`,
        )
      }
    } else if (!(await cloneSibling(repo, repoPath))) {
      logger.warning(
        `${repo} is not available (private without access, or absent); ` +
          `the speller weighting will use the in-tree corpus`,
      )
    }
  }
}

/** Build metadata key: `{repo: commit}` for the repos in the snapshot. */
const DEPENDENCY_REVISIONS_METADATA = "lang-dependency-revisions"

async function tar(args: string[], cwd: string): Promise<void> {
  const proc = new Deno.Command("tar", {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const code = (await proc.status).code
  if (code !== 0) {
    throw new Error(`tar ${args[0]} failed with exit code ${code}`)
  }
}

/**
 * Pack the build dependencies this checkout was just built against --
 * giella-core and the configure.ac-declared repos, as they sit in `../`,
 * built -- into `archive`, for `restoreLangDependencyRepos` in later steps.
 *
 * giella-core keeps its `.git`: every FST directory's `.generated/build-inputs`
 * stamp (giella-core's am-shared/dot-generated-dir.am) records
 * `git -C $(GTCORE) rev-parse HEAD`, and every FST depends on that stamp. A
 * giella-core without history makes that `no-git`, which no longer matches the
 * stamp in speller-build's workspace snapshot, so make would rebuild the whole
 * tree. The other repos leave `.git` out: nothing in the build reads their
 * history, and a lang-* dependency's history is large. The restore deletes
 * whatever it replaces, so an extracted `.git` always matches its tree.
 *
 * Nothing configure or make generates in these repos records their absolute
 * path, so the tree works from whatever directory a later step extracts it
 * into. Corpus repos are not packed: only the speller weighting reads them,
 * and no step that restores rebuilds a speller.
 */
export async function packLangDependencyRepos(archive: string): Promise<void> {
  const parent = path.resolve(Deno.cwd(), "..")
  const repos: string[] = []
  const revisions: Record<string, string> = {}
  for (const repo of ["giella-core", ...(await declaredDependencyRepos())]) {
    const repoPath = path.join(parent, repo)
    if (!(await fs.exists(repoPath))) {
      continue
    }
    repos.push(repo)
    const rev = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd: repoPath,
    }).output()
    revisions[repo] = new TextDecoder().decode(rev.stdout).trim() || "unknown"
  }

  logger.info(`Packing dependency repos: ${repos.join(", ")}`)
  await tar([
    "-I",
    "gzip -1",
    "-cpf",
    path.resolve(archive),
    ...repos.filter((repo) => repo !== "giella-core")
      .map((repo) => `--exclude=${repo}/.git`),
    ...repos,
  ], parent)
  const { size } = await Deno.stat(archive)
  logger.info(
    `${path.basename(archive)} is ${(size / 1024 / 1024).toFixed(1)} MiB`,
  )

  await builder.setMetadata(
    DEPENDENCY_REVISIONS_METADATA,
    JSON.stringify(revisions),
  )
}

/**
 * Unpack an archive made by `packLangDependencyRepos` into `destDir` (by
 * default this checkout's parent, where configure looks for the siblings),
 * deleting each repo it contains first so what's left is exactly what the
 * packing step built against. `repos` limits the unpack to those repos.
 *
 * Deleting is only ever correct for disposable CI checkouts; outside CI an
 * existing directory in the way is an error, never removed.
 */
export async function restoreLangDependencyRepos(
  archive: string,
  opts?: { destDir?: string; repos?: string[] },
): Promise<void> {
  const destDir = opts?.destDir ?? path.resolve(Deno.cwd(), "..")

  const list = await new Deno.Command("tar", {
    args: ["-tzf", archive],
  }).output()
  if (list.code !== 0) {
    throw new Error(`Failed to list ${archive}`)
  }
  const packed = new Set(
    new TextDecoder().decode(list.stdout).split("\n")
      .map((entry) => entry.replace(/^\.\//, "").split("/")[0])
      .filter((name) => name !== "" && name !== "."),
  )
  const repos = opts?.repos ?? [...packed]
  for (const repo of repos) {
    if (!packed.has(repo)) {
      throw new Error(`${repo} is not in ${archive}`)
    }
    const repoPath = path.join(destDir, repo)
    if (!(await fs.exists(repoPath))) {
      continue
    }
    if (!checkoutsAreDisposable()) {
      throw new Error(
        `${repoPath} already exists; refusing to replace it outside CI`,
      )
    }
    logger.info(`Removing ${repoPath} to replace it from the snapshot`)
    await Deno.remove(repoPath, { recursive: true })
  }

  logger.info(`Unpacking dependency repos into ${destDir}: ${repos.join(", ")}`)
  await tar(["-xpf", path.resolve(archive), ...repos], destDir)

  try {
    const revisions = JSON.parse(
      await builder.metadata(DEPENDENCY_REVISIONS_METADATA),
    ) as Record<string, string>
    for (const repo of repos) {
      logger.info(`${repo} is at ${revisions[repo] ?? "(unknown revision)"}`)
    }
  } catch (e) {
    logger.warning(`Could not read the dependency revisions: ${e}`)
  }
}
