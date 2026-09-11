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
 * Division of labour with the language's own autogen.sh: autogen already
 * clones AND bootstraps (autogen + configure) any missing build dependency, so
 * a missing build dep is left to it. What autogen never touches is (a) keeping
 * an existing checkout current -- the source of "speller rejects lemmas the
 * lexicon accepts" on long-lived agents -- and (b) the corpus repos. Those two
 * jobs are this module's.
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
 * Make the language's sibling dependency repos present and current.
 *
 * Build dependencies (giella-core plus whatever configure.ac declares) are
 * updated when present and left to autogen.sh when absent, and a failed
 * update is an error: building against a dependency that cannot be brought
 * current produces wrong results that nothing downstream will notice.
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

    logger.info("Building giella-core...")
    const make = new Deno.Command("make", { cwd: giellaCorePath }).spawn()
    if ((await make.status).code !== 0) {
      throw new Error("Failed to build giella-core")
    }
  }

  for (const repo of await declaredDependencyRepos()) {
    const repoPath = path.join(Deno.cwd(), "..", repo)
    if (await fs.exists(repoPath)) {
      await updateDependencyRepo(repoPath, repo)
    } else {
      logger.info(
        `${repo} is not checked out; autogen.sh will clone and bootstrap it`,
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
