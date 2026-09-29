import * as path from "@std/path"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { createTarZst, extractTarball, listTarball } from "~/util/tarball.ts"
import { makeTempDir } from "~/util/temp.ts"

/**
 * Sibling dependency repos for a language build.
 *
 * A language checkout builds against repos that live BESIDE it: giella-core,
 * the shared-* lexicon repos, sometimes other lang-* repos, and the speller
 * corpus repos. Which ones a language needs is not for the pipeline to know:
 * configure.ac declares the build dependencies (gt_USE_SHARED / gt_NEED_SHARED
 * lines), and the speller weighting reads ../corpus-<lang> and
 * ../corpus-<lang>-x-closed when they exist (giella-core 1.15.2+).
 *
 * One step decides all of them. The lang-deps step fetches each repo's
 * current commit into a fresh directory, builds what needs building, records
 * the commits as build metadata and packs the result
 * (`prepareLangDependencies`). Every other step unpacks that snapshot over its
 * own siblings (`restoreLangDependencyRepos`) and fetches the recorded corpus
 * commits (`checkoutCorpusRepos`). No step pulls, and nothing an earlier build
 * left on an agent is ever built against, so one build uses one set of
 * dependency commits however many agents its steps land on.
 */

/**
 * Discarding or deleting a sibling checkout is only correct where it is a
 * disposable build input. On CI agents it is; outside CI `..` may be a
 * developer's working tree with uncommitted work, and a build step must never
 * eat that.
 */
function checkoutsAreDisposable(): boolean {
  return Deno.env.get("BUILDKITE") != null
}

async function run(cmd: string, args: string[], cwd: string): Promise<void> {
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const code = (await proc.status).code
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed with exit code ${code}`)
  }
}

async function capture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const out = await new Deno.Command(cmd, { args, cwd, stderr: "inherit" })
    .output()
  if (out.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed with exit code ${out.code}`,
    )
  }
  return new TextDecoder().decode(out.stdout).trim()
}

/** A sibling repo configure.ac declares as a build dependency. */
export type Dependency = {
  repo: string
  /**
   * Declared with gt_NEED_SHARED, whose version floor is checked against the
   * repo's own `.pc` file -- which only its configure writes. A plain
   * gt_USE_SHARED only needs the directory to exist.
   */
  needsConfigure: boolean
}

/**
 * The sibling repos configure.ac declares as build dependencies, in
 * declaration order. `gt_USE_SHARED([smi], [shared-smi], [giella-shared-smi])`
 * names the repo in its second argument; gt_NEED_SHARED repeats a USE line to
 * add a version floor, so a repo declared both ways needs configuring.
 */
export async function declaredDependencies(
  langDir: string = Deno.cwd(),
): Promise<Dependency[]> {
  const configureAc = path.join(langDir, "configure.ac")
  if (!(await fs.exists(configureAc))) {
    return []
  }
  const text = await Deno.readTextFile(configureAc)
  const deps = new Map<string, boolean>()
  const uses = text.matchAll(
    /^\s*gt_(USE|NEED)_SHARED\(\s*\[[^\]]*\]\s*,\s*\[([^\]]+)\]/gm,
  )
  for (const [, macro, repo] of uses) {
    deps.set(repo, (deps.get(repo) ?? false) || macro === "NEED")
  }
  return [...deps].map(([repo, needsConfigure]) => ({ repo, needsConfigure }))
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
  const originUrl = await capture(
    "git",
    ["remote", "get-url", "origin"],
    Deno.cwd(),
  )
  return originUrl.replace(/[^/:]+?(\.git)?$/, `${repoName}.git`)
}

/**
 * Make `dir` exactly `repo` at `ref` (a commit, or "HEAD" for the default
 * branch's current commit), and return the commit it is at.
 *
 * The same steps work on a missing directory, an earlier clone at any commit,
 * or a directory that isn't a repo at all: fetch just that one commit, force
 * the tree to it, and remove anything else. `sparse` limits the checkout to
 * those sparse-checkout patterns (`/src/`, `/*.pc.in`) and fetches only the
 * files they match.
 *
 * Outside CI an existing directory is left as it is (see
 * `checkoutsAreDisposable`).
 */
async function fetchRepo(
  repo: string,
  dir: string,
  opts: { ref: string; sparse?: string[] },
): Promise<string> {
  if ((await fs.exists(dir)) && !checkoutsAreDisposable()) {
    logger.warning(
      `Leaving ${repo} as it is (not on CI, so it may be a working tree)`,
    )
    return await capture("git", ["rev-parse", "HEAD"], dir)
  }

  const url = await siblingCloneUrl(repo)
  logger.info(`Fetching ${repo} at ${opts.ref} from ${url}`)
  await fs.ensureDir(dir)
  await run("git", ["init", "-q"], dir)
  await run("git", ["config", "remote.origin.url", url], dir)
  if (opts.sparse) {
    await run("git", [
      "sparse-checkout",
      "set",
      "--no-cone",
      ...opts.sparse,
    ], dir)
  }
  await run("git", [
    "fetch",
    "-q",
    "--depth",
    "1",
    ...(opts.sparse ? ["--filter=blob:none"] : []),
    "origin",
    opts.ref,
  ], dir)
  await run("git", ["checkout", "-q", "-f", "--detach", "FETCH_HEAD"], dir)
  await run("git", ["clean", "-ffdxq"], dir)

  const log = await capture("git", ["log", "-1", "--format=%h %cI %s"], dir)
  logger.info(`${repo} is at ${log}`)
  return await capture("git", ["rev-parse", "HEAD"], dir)
}

/**
 * Every other step unpacks giella-core at its own path and runs its scripts
 * there without configuring it again: configure rewrites every file it
 * generates, and scripts/generate-nfc-nfd-regex.bash is a prerequisite of
 * every language's orthography FSTs, so a configure there would make that
 * step's make rebuild everything downstream of them, spellers included. That
 * only works while no script giella-core generates records the directory it
 * was configured in (giella-core's scripts find their own directory instead).
 * A giella-core whose scripts do would run them from this step's temp
 * directory, long deleted, so say so here rather than later in a test.
 */
async function checkGiellaCoreIsRelocatable(giellaCore: string): Promise<void> {
  const scripts = path.join(giellaCore, "scripts")
  const stale: string[] = []
  for await (const entry of Deno.readDir(scripts)) {
    if (!entry.isFile || entry.name.startsWith("Makefile")) {
      continue
    }
    const text = await Deno.readTextFile(path.join(scripts, entry.name))
      .catch(() => "")
    if (text.includes(giellaCore)) {
      stale.push(entry.name)
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `giella-core's configure wrote the directory it ran in into ` +
        `scripts/${stale.join(", scripts/")}, so they would not work where ` +
        `the other steps unpack it. They must find giella-core from their ` +
        `own location instead.`,
    )
  }
}

/** Build metadata key: `{repo: commit}` for the repos in the snapshot. */
const DEPENDENCY_REVISIONS_METADATA = "lang-dependency-revisions"

/** Build metadata key: `{repo: commit}` for the corpus repos this build uses. */
const CORPUS_REVISIONS_METADATA = "lang-corpus-revisions"

/**
 * The lang-deps step: fetch giella-core and the configure.ac-declared repos at
 * their current commits into a fresh directory, build them, record the
 * commits of those and of the corpus repos, and pack the repos into
 * `archive` for `restoreLangDependencyRepos` in every other step.
 *
 * giella-core is built in full, and a failure there is fatal: it is a hard
 * build requirement. A declared repo is best-effort, as configure treats it: a
 * gt_USE_SHARED repo that is missing only downgrades to a configure warning,
 * while a gt_NEED_SHARED one fails configure in the step that needs it, which
 * is where that is reported. A declared repo that failed is left out of the
 * snapshot rather than packed half-made.
 *
 * Every repo is fetched whole, even where a language build reads only its
 * `src/`: the language's make, its autogen.sh and scripts like teaksta's each
 * look at siblings in their own way, and a partial checkout only fails the
 * one nobody listed. Only a gt_NEED_SHARED repo is configured (autoreconf,
 * not the repo's own autogen.sh, which in a lang-* repo clones missing
 * siblings of its own).
 *
 * giella-core keeps its `.git`: every FST directory's `.generated/build-inputs`
 * stamp (giella-core's am-shared/dot-generated-dir.am) records
 * `git -C $(GTCORE) rev-parse HEAD`, and every FST depends on that stamp. A
 * giella-core without history makes that `no-git`, which no longer matches the
 * stamp in speller-build's workspace snapshot, so make would rebuild the whole
 * tree. The other repos leave `.git` out: nothing in the build reads their
 * history.
 *
 * Corpus repos are only resolved to a commit here, not packed: they are
 * large, and the closed one must not become an artifact. One that can't be
 * resolved (absent, or private without access) is left out, and the speller
 * is weighted without it.
 */
export async function prepareLangDependencies(archive: string): Promise<void> {
  const workDir = (await makeTempDir({ prefix: "lang-deps-" })).path
  try {
    const revisions: Record<string, string> = {}

    const giellaCore = path.join(workDir, "giella-core")
    // TEMPORARY: giellalt/giella-core#457 (scripts find giella-core from
    // their own location), until it is merged. Back to "HEAD" then.
    revisions["giella-core"] = await fetchRepo("giella-core", giellaCore, {
      ref: "self-locating-scripts",
    })
    logger.info("Building giella-core...")
    await run(
      "bash",
      ["-c", "autoreconf -i && ./configure && make"],
      giellaCore,
    )
    await checkGiellaCoreIsRelocatable(giellaCore)

    for (const { repo, needsConfigure } of await declaredDependencies()) {
      const dir = path.join(workDir, repo)
      try {
        revisions[repo] = await fetchRepo(repo, dir, { ref: "HEAD" })
        if (needsConfigure) {
          logger.info(`Configuring ${repo}...`)
          await run("bash", ["-c", "autoreconf -i && ./configure"], dir)
        }
      } catch (e) {
        logger.warning(
          `Leaving ${repo} out of the dependency snapshot: ${e}. configure ` +
            "will fail where it is required (gt_NEED_SHARED), or degrade " +
            "gracefully where not (gt_USE_SHARED)",
        )
        delete revisions[repo]
        await Deno.remove(dir, { recursive: true }).catch(() => {})
      }
    }

    const corpusRevisions: Record<string, string> = {}
    for (const repo of corpusRepos(builder.env.repoName)) {
      try {
        const head = await capture("git", [
          "ls-remote",
          await siblingCloneUrl(repo),
          "HEAD",
        ], Deno.cwd())
        const commit = head.split(/\s/)[0]
        if (commit) {
          corpusRevisions[repo] = commit
          logger.info(`${repo} is at ${commit}`)
        }
      } catch (e) {
        logger.warning(
          `${repo} is not available (private without access, or absent); ` +
            `the speller weighting will not use it: ${e}`,
        )
      }
    }

    await builder.setMetadata(
      DEPENDENCY_REVISIONS_METADATA,
      JSON.stringify(revisions),
    )
    await builder.setMetadata(
      CORPUS_REVISIONS_METADATA,
      JSON.stringify(corpusRevisions),
    )

    const repos = Object.keys(revisions)
    logger.info(`Packing dependency repos: ${repos.join(", ")}`)
    await createTarZst(path.resolve(archive), repos, {
      cwd: workDir,
      exclude: repos.filter((repo) => repo !== "giella-core")
        .map((repo) => `${repo}/.git`),
    })
  } finally {
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}

/**
 * Unpack an archive made by `prepareLangDependencies` into `destDir` (by
 * default this checkout's parent, where configure looks for the siblings),
 * deleting each repo it contains first so what's left is exactly what the
 * lang-deps step built. `repos` limits the unpack to those repos.
 *
 * Nothing is configured or built here: the repos are used exactly as packed,
 * mtimes included, so make sees them as unchanged (see
 * `checkGiellaCoreIsRelocatable` for why that works from any directory).
 *
 * Deleting is only ever correct for disposable CI checkouts; outside CI an
 * existing directory in the way is an error, never removed.
 */
export async function restoreLangDependencyRepos(
  archive: string,
  opts?: { destDir?: string; repos?: string[] },
): Promise<void> {
  const destDir = opts?.destDir ?? path.resolve(Deno.cwd(), "..")

  const packed = new Set(
    (await listTarball(archive))
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
  await extractTarball(archive, { cwd: destDir, paths: repos })

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

/**
 * Tell giella-core which corpus repos the speller weighting uses, for every
 * make this process runs from here on. giella-core refuses to guess the
 * corpus when CI is set.
 */
function useCorpusRepos(repos: string[]): void {
  Deno.env.set("GIELLA_CORPUS_REPOS", repos.join(" "))
  logger.info(
    `Speller corpus: ${
      repos.length > 0 ? repos.join(", ") : "in-tree weights/*.raw.txt"
    }`,
  )
}

/**
 * Put the corpus repos at the commits the lang-deps step recorded beside this
 * checkout, and name the ones with text in GIELLA_CORPUS_REPOS, so every
 * step's make resolves the speller corpus exactly alike. Any other answer --
 * a repo missing here, or at another commit -- rebuilds the weighting, and a
 * test step would then test a speller that was never shipped. So a repo that
 * can't be fetched is fatal.
 *
 * Only `converted/` is fetched: it is what the weighting reads, and a repo
 * without it has no text to weight with. Every step fetches the same commit,
 * so every step makes the same call.
 */
export async function checkoutCorpusRepos(): Promise<void> {
  const revisions = JSON.parse(
    await builder.metadata(CORPUS_REVISIONS_METADATA),
  ) as Record<string, string>
  const present: string[] = []
  for (const [repo, commit] of Object.entries(revisions)) {
    const dir = path.join(Deno.cwd(), "..", repo)
    await fetchRepo(repo, dir, { ref: commit, sparse: ["/converted/"] })
    if (await fs.exists(path.join(dir, "converted"))) {
      present.push(repo)
    } else {
      logger.warning(`${repo} has no converted/ directory; not using it`)
    }
  }
  useCorpusRepos(present)
}
