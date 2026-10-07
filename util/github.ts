import * as path from "@std/path"
import logger from "./log.ts"
import { makeTempDir } from "./temp.ts"

/** A non-zero `gh api` exit. `status` is the HTTP code when `gh` reported one. */
export class GitHubApiError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = "GitHubApiError"
    this.status = status
    Object.setPrototypeOf(this, GitHubApiError.prototype)
  }
}

/** How long a gh call keeps retrying GitHub's transient failures. */
const RETRY_DEADLINE_MS = 15 * 60 * 1000
const RETRY_FIRST_DELAY_MS = 5 * 1000
const RETRY_MAX_DELAY_MS = 2 * 60 * 1000

/**
 * A gh failure worth retrying: GitHub answering 5xx (it has failed release
 * asset writes with HTTP 500 for minutes while reporting no incident) or the
 * connection dropping. 4xx answers are the request's own fault and are not.
 */
function isTransient(stderr: string): boolean {
  return new RegExp(
    [
      "HTTP 5\\d\\d",
      "connection reset",
      "connection refused",
      "unexpected EOF",
      "i/o timeout",
      "TLS handshake timeout",
      "timed out",
      "temporarily unavailable",
    ].join("|"),
    "i",
  ).test(stderr)
}

export interface GhResult {
  code: number
  stdout: Uint8Array
  stderr: string
}

/**
 * Runs `gh args`, retrying transient failures (isTransient) with a doubling
 * delay, from RETRY_FIRST_DELAY_MS up to RETRY_MAX_DELAY_MS, until
 * RETRY_DEADLINE_MS has passed since the first attempt; then the last result
 * is returned. gh's stderr is captured to classify the failure and written to
 * this process's stderr after each attempt so the build log keeps it. stdout
 * is captured when `capture` is set and passed through otherwise.
 * `alreadyDone`, when given, is asked before each retry whether the failed
 * attempt took effect after all (a 5xx can follow a completed write); if so
 * the call counts as a success.
 */
export async function ghWithRetry(
  args: string[],
  opts: {
    capture?: boolean
    stdin?: Uint8Array
    alreadyDone?: () => Promise<boolean>
  } = {},
): Promise<GhResult> {
  const deadline = Date.now() + RETRY_DEADLINE_MS
  let delay = RETRY_FIRST_DELAY_MS
  for (let attempt = 1;; attempt++) {
    const proc = new Deno.Command("gh", {
      args,
      stdin: opts.stdin ? "piped" : "null",
      stdout: opts.capture ? "piped" : "inherit",
      stderr: "piped",
    }).spawn()
    if (opts.stdin) {
      const w = proc.stdin.getWriter()
      await w.write(opts.stdin)
      await w.close()
    }
    const out = await proc.output()
    const stderr = new TextDecoder().decode(out.stderr)
    if (stderr) {
      await Deno.stderr.write(out.stderr)
    }
    const result = {
      code: out.code,
      stdout: opts.capture ? out.stdout : new Uint8Array(),
      stderr: stderr.trim(),
    }
    if (result.code === 0 || !isTransient(stderr)) {
      return result
    }
    if (Date.now() + delay > deadline) {
      logger.warning(
        `gh ${args[0]} ${args[1] ?? ""}: still failing after ${attempt} attempts over ${
          RETRY_DEADLINE_MS / 60000
        } minutes; giving up`,
      )
      return result
    }
    logger.warning(
      `gh ${args[0]} ${args[1] ?? ""} failed transiently (attempt ${attempt}); retrying in ${
        delay / 1000
      }s`,
    )
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS)
    if (opts.alreadyDone && await opts.alreadyDone()) {
      return { code: 0, stdout: new Uint8Array(), stderr: "" }
    }
  }
}

export interface GitHubRelease {
  tagName: string
  name: string
  url: string
  publishedAt: string
  isDraft: boolean
  isPrerelease: boolean
  assets: Array<{
    name: string
    url: string
    downloadUrl: string
  }>
}

export class GitHub {
  #repo: string
  /** `GET repos/{slug}`, fetched at most once per instance (see `#getRepo`). */
  #repoData?: Promise<Record<string, unknown>>

  constructor(repo: string) {
    this.#repo = repo
  }

  /** `git@github.com:giellalt/lang-olo.git` / a clone URL → `giellalt/lang-olo`. */
  #slug(): string {
    const m = this.#repo.match(/([^/:]+\/[^/:]+?)(?:\.git)?\/?$/)
    if (!m) {
      throw new Error(`Cannot derive owner/repo from "${this.#repo}"`)
    }
    return m[1]
  }

  /**
   * `GET repos/{slug}`, memoised for the life of this instance — the docs-data
   * flow reads it three times (`#canonicalSlug` twice, `repoMetadata` once) and
   * the repo's identity/visibility/licence don't change mid-build. `gh api`
   * follows the rename 307 on a GET, so `#slug()` (which can lag a rename) is a
   * fine path here. A failed fetch is not cached, so a later call can retry.
   */
  #getRepo(): Promise<Record<string, unknown>> {
    return (this.#repoData ??= (async () => {
      try {
        return await this.#api([`repos/${this.#slug()}`]) as Record<
          string,
          unknown
        >
      } catch (e) {
        this.#repoData = undefined
        throw e
      }
    })())
  }

  /**
   * Resolve `#slug()` to the repo's current `owner/name`. Buildkite's configured
   * remote can lag a GitHub rename (git redirects transparently, so clone/push
   * never notice); the REST API answers a renamed path with a 307 that `gh api`
   * won't follow on writes. A GET *is* followed, and `.full_name` is canonical.
   */
  async #canonicalSlug(): Promise<string> {
    const slug = this.#slug()
    try {
      const { full_name } = await this.#getRepo() as { full_name?: string }
      if (full_name && full_name !== slug) {
        logger.info(`${slug} was renamed to ${full_name}; using that`)
      }
      return full_name ?? slug
    } catch {
      return slug
    }
  }

  async #api(args: string[], body?: unknown): Promise<unknown> {
    const { code, stdout, stderr } = await ghWithRetry(["api", ...args], {
      capture: true,
      stdin: body === undefined
        ? undefined
        : new TextEncoder().encode(JSON.stringify(body)),
    })
    if (code !== 0) {
      const status = stderr.match(/HTTP (\d{3})/)?.[1]
      throw new GitHubApiError(
        `gh api ${args.join(" ")} failed (${code}): ${stderr}`,
        status ? Number(status) : null,
      )
    }
    const out = new TextDecoder().decode(stdout).trim()
    return out ? JSON.parse(out) : null
  }

  /**
   * Replace `branch` with a single parentless commit holding exactly `files`
   * (flat, at the root), force-pushed with git. Used for the rolling
   * `generated/docs-data` branch (see docs/badgedata-artifact-migration.md):
   * each build overwrites it, so it always holds the latest build's data and
   * never accumulates history.
   *
   * A real `git push` rather than the Git Data API: the API's create-blob call
   * refuses large files (HTTP 422, "your input was too large to process"),
   * which the full speller accuracy reports can hit. git takes files up to
   * GitHub's 100 MB limit; a file past that fails the whole push, so
   * `publishGeneratedDocsData` holds such files back, pushes the rest, and
   * then fails. It is also one push instead of one API call per file.
   *
   * Authenticates with gh's own credentials (`gh auth git-credential`), so it
   * pushes as the same identity as every other call here and needs no token
   * handling of its own. A push rejected for lack of access is raised as a
   * `GitHubApiError` with status 403, like the API equivalent.
   */
  async publishBranch(
    branch: string,
    files: Array<{ path: string; source: string }>,
    opts: { message: string },
  ): Promise<void> {
    const slug = await this.#canonicalSlug()
    await using work = await makeTempDir({ prefix: "publish-branch-" })

    for (const f of files) {
      await Deno.copyFile(f.source, path.join(work.path, f.path))
    }

    const git = async (args: string[]): Promise<string> => {
      const { code, stdout, stderr } = await new Deno.Command("git", {
        args: [
          // Ignore the agent's global git config where it could interfere.
          "-c",
          "commit.gpgsign=false",
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          ...args,
        ],
        cwd: work.path,
        stdout: "piped",
        stderr: "piped",
      }).output()
      const err = new TextDecoder().decode(stderr).trim()
      if (code !== 0) {
        const msg = `git ${args[0]} failed (${code}): ${err}`
        // "Permission to <repo>.git denied to <user>" / "Repository not found"
        // (GitHub hides a repo you can't write to as not found).
        if (/denied|403|Repository not found|404/.test(err)) {
          throw new GitHubApiError(msg, 403)
        }
        throw new Error(msg)
      }
      return new TextDecoder().decode(stdout).trim()
    }

    // Commit as the token's user, as the API did implicitly. Only cosmetic, so
    // a lookup failure (e.g. an app token, which has no user) doesn't block.
    let name = "divvun-actions"
    let email = "divvun-actions@users.noreply.github.com"
    try {
      const { login, id } = await this.#api(["user"]) as {
        login: string
        id: number
      }
      name = login
      email = `${id}+${login}@users.noreply.github.com`
    } catch { /* keep the fallback identity */ }

    await git(["init", "--quiet"])
    await git(["add", "--all"])
    await git([
      "-c",
      `user.name=${name}`,
      "-c",
      `user.email=${email}`,
      "commit",
      "--quiet",
      "--message",
      opts.message,
    ])
    const sha = await git(["rev-parse", "HEAD"])

    logger.info(
      `Publishing ${files.length} files to ${slug}@${branch} (${
        sha.slice(0, 8)
      })`,
    )
    await git([
      "push",
      "--quiet",
      "--force",
      `https://github.com/${slug}.git`,
      `HEAD:refs/heads/${branch}`,
    ])
  }

  /**
   * Repo facts the docs-data step needs in one place: visibility (which selects
   * the private publishing path — see `actions/lang/docs-publish.ts`) and, for a
   * private repo only, the `license` / `issues` / `DocCI` badge inputs.
   * shields.io renders those three itself for a public repo but 404s on a
   * private one, so only a private build renders SVGs for them and only a
   * private build needs to look them up. Each call soft-fails to a neutral
   * default so a transient API error can't fail the build over a badge.
   */
  async repoMetadata(): Promise<{
    private: boolean
    license: string | null
    openIssues: number
    docsConclusion: string | null
  }> {
    const slug = await this.#canonicalSlug()

    let isPrivate = false
    let license: string | null = null

    try {
      const repo = await this.#getRepo() as {
        private?: boolean
        license?: { spdx_id?: string | null } | null
      }
      isPrivate = repo.private ?? false
      const spdx = repo.license?.spdx_id
      license = spdx && spdx !== "NOASSERTION" ? spdx : null
    } catch (e) {
      logger.warning(`repoMetadata: repos/${slug} lookup failed: ${e}`)
    }

    if (!isPrivate) {
      return { private: false, license, openIssues: 0, docsConclusion: null }
    }

    let openIssues = 0
    let docsConclusion: string | null = null

    try {
      const res = await this.#api([
        "search/issues",
        "-f",
        `q=repo:${slug} is:issue is:open`,
        "-F",
        "per_page=1",
      ]) as { total_count?: number }
      openIssues = res.total_count ?? 0
    } catch (e) {
      logger.warning(`repoMetadata: open-issue search failed: ${e}`)
    }

    try {
      const res = await this.#api([
        `repos/${slug}/actions/workflows/docs.yml/runs`,
        "-F",
        "per_page=1",
        "-f",
        "status=completed",
        "-f",
        "exclude_pull_requests=true",
      ]) as { workflow_runs?: Array<{ conclusion?: string | null }> }
      docsConclusion = res.workflow_runs?.[0]?.conclusion ?? null
    } catch (e) {
      logger.warning(`repoMetadata: docs.yml run lookup failed: ${e}`)
    }

    return { private: true, license, openIssues, docsConclusion }
  }

  /**
   * Ask GitHub Actions to rebuild the repo's docs site (the `docs.yml`
   * workflow), via `workflow_dispatch`. Only used for private repos: their docs
   * site embeds a *copy* of the `generated/docs-data` branch at build time — it
   * can't read the branch at view time, because `raw.githubusercontent.com`
   * needs auth and sends no CORS header — so a rebuild is the only way fresh
   * badge/test data reaches the page. A public repo's docs page fetches the
   * branch live and needs no rebuild.
   *
   * Needs the CI token's `actions: write` (the GiellaLT CI identity has it); a
   * caller that treats a failure here as fatal would be wrong — the build's
   * data is already published, only the rebuild trigger is best-effort.
   */
  async dispatchDocsWorkflow(ref = "main"): Promise<void> {
    const slug = await this.#canonicalSlug()
    await this.#api(
      [
        "-X",
        "POST",
        `repos/${slug}/actions/workflows/docs.yml/dispatches`,
        "--input",
        "-",
      ],
      { ref },
    )
    logger.info(`Triggered docs.yml rebuild on ${slug}`)
  }

  async createRelease(
    tag: string,
    artifacts: string[],
    options: {
      draft?: boolean
      prerelease?: boolean
      latest?: boolean
      verifyTag?: boolean
      name?: string
    } = {},
  ) {
    const {
      draft = false,
      prerelease = false,
      latest = false,
      verifyTag = true,
      name,
    } = options

    const args = [
      "release",
      "create",
      tag,
      "--generate-notes",
      `--latest=${latest}`,
      "--repo",
      this.#repo,
      ...artifacts,
    ]

    if (verifyTag) {
      args.splice(3, 0, "--verify-tag")
    }

    if (name) {
      args.push("--title", name)
    }

    if (draft) {
      args.push("--draft")
    }

    if (prerelease) {
      args.push("--prerelease")
    }

    logger.info(
      `Creating GitHub release: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )
    // A 5xx can follow a release that was created after all; the retry would
    // then fail as a duplicate, so check first and finish with an upload.
    const { code } = await ghWithRetry(args, {
      alreadyDone: async () => {
        if (!await this.releaseExists(tag)) return false
        logger.info(`Release ${tag} was created; uploading its assets`)
        if (artifacts.length > 0) await this.uploadRelease(tag, artifacts)
        return true
      },
    })
    if (code !== 0) {
      throw new Error(`Failed to create GitHub release: exit code ${code}`)
    }
  }

  async uploadRelease(tag: string, artifacts: string[]) {
    const args = [
      "release",
      "upload",
      tag,
      "--clobber",
      "--repo",
      this.#repo,
      ...artifacts,
    ]

    logger.info(
      `Uploading to release: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )
    // --clobber makes a repeated upload replace what a failed one left.
    const { code } = await ghWithRetry(args)
    if (code !== 0) {
      throw new Error(`Failed to upload to release: exit code ${code}`)
    }
  }

  /**
   * Reset a release's published_at timestamp to now by toggling it
   * through draft and back to published.
   */
  async refreshReleaseTimestamp(tag: string) {
    const editArgs = (draft: boolean) => [
      "release",
      "edit",
      tag,
      `--draft=${draft}`,
      "--repo",
      this.#repo,
    ]

    const { code: draftCode } = await ghWithRetry(editArgs(true))
    if (draftCode !== 0) {
      logger.warning(
        `Failed to set release ${tag} to draft: exit code ${draftCode}`,
      )
      return
    }

    const { code: publishCode } = await ghWithRetry(editArgs(false))
    if (publishCode !== 0) {
      logger.warning(
        `Failed to publish release ${tag}: exit code ${publishCode}`,
      )
    }
  }

  async releaseExists(tag: string): Promise<boolean> {
    const args = ["release", "view", tag, "--repo", this.#repo]

    const { code, stderr } = await ghWithRetry(args, { capture: true })
    if (code !== 0 && !/release not found/i.test(stderr)) {
      throw new Error(`Failed to look up release ${tag}: ${stderr}`)
    }
    return code === 0
  }

  async ensureTagExists(tag: string): Promise<void> {
    logger.info(`Force-updating tag ${tag} to HEAD...`)

    // Force create/update the tag at HEAD
    const createTagProc = new Deno.Command("git", {
      args: ["tag", "-f", tag, "HEAD"],
    }).spawn()

    const { code: createTagCode } = await createTagProc.output()
    if (createTagCode !== 0) {
      throw new Error(`Failed to create tag ${tag}: exit code ${createTagCode}`)
    }

    logger.debug(`Created/updated tag ${tag} at HEAD`)

    // Force push the tag to origin
    const pushTagProc = new Deno.Command("git", {
      args: ["push", "origin", tag, "-f"],
    }).spawn()

    const { code: pushTagCode } = await pushTagProc.output()
    if (pushTagCode !== 0) {
      throw new Error(`Failed to push tag ${tag}: exit code ${pushTagCode}`)
    }

    logger.info(`Successfully force-pushed tag ${tag} to HEAD`)
  }

  async updateRelease(
    tag: string,
    artifacts: string[],
    options: {
      draft?: boolean
      prerelease?: boolean
      name?: string
    } = {},
  ) {
    const { draft = true, prerelease = true, name } = options

    const exists = await this.releaseExists(tag)

    if (exists) {
      logger.info(`Release ${tag} exists, fetching assets to delete...`)

      const viewArgs = [
        "release",
        "view",
        tag,
        "--repo",
        this.#repo,
        "--json",
        "assets",
      ]

      const { code: viewCode, stdout: viewStdout } = await ghWithRetry(
        viewArgs,
        { capture: true },
      )
      if (viewCode === 0) {
        const releaseData = JSON.parse(
          new TextDecoder().decode(viewStdout),
        ) as {
          assets: Array<{ name: string }>
        }

        for (const asset of releaseData.assets) {
          logger.info(`Deleting asset ${asset.name} from release ${tag}...`)
          const deleteArgs = [
            "release",
            "delete-asset",
            tag,
            asset.name,
            "--repo",
            this.#repo,
            "--yes",
          ]

          // A retried delete of an asset the failed attempt removed after all
          // answers "not found", which is what we wanted.
          const { code: deleteCode, stderr: deleteErr } = await ghWithRetry(
            deleteArgs,
          )
          if (deleteCode !== 0 && !/not found/i.test(deleteErr)) {
            logger.warning(
              `Failed to delete asset ${asset.name}: exit code ${deleteCode}`,
            )
          }
        }
      }

      logger.info(`Uploading new artifacts to existing release ${tag}...`)
      await this.uploadRelease(tag, artifacts)

      const editArgs = [
        "release",
        "edit",
        tag,
        "--repo",
        this.#repo,
      ]

      if (name) {
        editArgs.push("--title", name)
      }
      editArgs.push(`--draft=${draft}`, `--prerelease=${prerelease}`)

      const { code: editCode } = await ghWithRetry(editArgs)
      if (editCode !== 0) {
        logger.warning(
          `Failed to update release metadata for ${tag}: exit code ${editCode}`,
        )
      }
    } else {
      logger.info(
        `Release ${tag} does not exist, creating as draft and prerelease...`,
      )
      await this.ensureTagExists(tag)
      await this.createRelease(tag, artifacts, {
        draft,
        prerelease,
        latest: false,
        verifyTag: true,
        name,
      })
    }
  }

  async getLatestRelease(
    pattern: string | RegExp,
    includePrerelease = false,
  ): Promise<GitHubRelease | null> {
    const args = [
      "release",
      "list",
      "--repo",
      this.#repo,
      "--json",
      "tagName,name,url,publishedAt,isDraft,isPrerelease,assets",
    ]

    logger.debug(
      `Fetching GitHub releases: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )

    const { code, stdout, stderr } = await ghWithRetry(args, { capture: true })
    if (code !== 0) {
      throw new Error(`Failed to fetch GitHub releases: ${stderr}`)
    }

    const releases = JSON.parse(new TextDecoder().decode(stdout)) as Array<{
      tagName: string
      name: string
      url: string
      publishedAt: string
      isDraft: boolean
      isPrerelease: boolean
      assets: Array<{
        name: string
        url: string
        browserDownloadUrl: string
      }>
    }>

    const filteredReleases = releases
      .filter((release) => {
        if (!includePrerelease && release.isPrerelease) {
          return false
        }
        if (release.isDraft) {
          return false
        }

        if (pattern instanceof RegExp) {
          return pattern.test(release.tagName)
        } else {
          return release.tagName.includes(pattern)
        }
      })
      .sort((a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      )

    if (filteredReleases.length === 0) {
      return null
    }

    const latest = filteredReleases[0]
    return {
      tagName: latest.tagName,
      name: latest.name,
      url: latest.url,
      publishedAt: latest.publishedAt,
      isDraft: latest.isDraft,
      isPrerelease: latest.isPrerelease,
      assets: latest.assets.map((asset) => ({
        name: asset.name,
        url: asset.url,
        downloadUrl: asset.browserDownloadUrl,
      })),
    }
  }

  async downloadReleaseAssets(
    tagName: string,
    assetPattern?: string | RegExp,
    downloadDir = "./downloads",
  ): Promise<string[]> {
    const args = [
      "release",
      "download",
      tagName,
      "--repo",
      this.#repo,
      "--dir",
      downloadDir,
    ]

    if (assetPattern) {
      if (assetPattern instanceof RegExp) {
        args.push("--pattern", assetPattern.source)
      } else {
        args.push("--pattern", assetPattern)
      }
    }

    logger.info(
      `Downloading release assets: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )

    // --clobber so a retry can overwrite a partial download.
    args.push("--clobber")
    const { code, stdout, stderr } = await ghWithRetry(args, { capture: true })
    if (code !== 0) {
      throw new Error(`Failed to download release assets: ${stderr}`)
    }

    const outputText = new TextDecoder().decode(stdout)
    return outputText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim())
  }
}
