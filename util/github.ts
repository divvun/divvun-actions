import { encodeBase64 } from "@std/encoding/base64"
import logger from "./log.ts"

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
    const proc = new Deno.Command("gh", {
      args: ["api", ...args],
      stdin: body === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn()

    if (body !== undefined) {
      const w = proc.stdin.getWriter()
      await w.write(new TextEncoder().encode(JSON.stringify(body)))
      await w.close()
    }

    const { code, stdout, stderr } = await proc.output()
    if (code !== 0) {
      const err = new TextDecoder().decode(stderr).trim()
      const status = err.match(/HTTP (\d{3})/)?.[1]
      throw new GitHubApiError(
        `gh api ${args.join(" ")} failed (${code}): ${err}`,
        status ? Number(status) : null,
      )
    }
    const out = new TextDecoder().decode(stdout).trim()
    return out ? JSON.parse(out) : null
  }

  /**
   * Publish a flat set of files to `branch` via the GitHub Git Data API — no
   * working-tree checkout. Used for the rolling `docs-data` branch (see
   * docs/badgedata-artifact-migration.md): with `orphan: true` each build
   * force-pushes a fresh parentless commit, so the branch always holds exactly
   * the latest build's generated data and never accumulates history.
   */
  async publishBranch(
    branch: string,
    files: Array<{ path: string; source: string }>,
    opts: { message: string; orphan?: boolean },
  ): Promise<void> {
    const slug = await this.#canonicalSlug()

    const tree: Array<
      { path: string; mode: "100644"; type: "blob"; sha: string }
    > = []
    for (const f of files) {
      const bytes = await Deno.readFile(f.source)
      const blob = await this.#api(
        ["-X", "POST", `repos/${slug}/git/blobs`, "--input", "-"],
        { content: encodeBase64(bytes), encoding: "base64" },
      ) as { sha: string }
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha })
    }

    // No base_tree: the commit is a complete snapshot of `files`.
    const treeObj = await this.#api(
      ["-X", "POST", `repos/${slug}/git/trees`, "--input", "-"],
      { tree },
    ) as { sha: string }

    let parents: string[] = []
    if (!opts.orphan) {
      try {
        const ref = await this.#api(
          [`repos/${slug}/git/ref/heads/${branch}`],
        ) as { object: { sha: string } }
        parents = [ref.object.sha]
      } catch {
        // branch doesn't exist yet — first publish
      }
    }

    const commit = await this.#api(
      ["-X", "POST", `repos/${slug}/git/commits`, "--input", "-"],
      { message: opts.message, tree: treeObj.sha, parents },
    ) as { sha: string }

    logger.info(
      `Publishing ${files.length} files to ${slug}@${branch} (${
        commit.sha.slice(0, 8)
      })`,
    )

    try {
      await this.#api(
        [
          "-X",
          "PATCH",
          `repos/${slug}/git/refs/heads/${branch}`,
          "--input",
          "-",
        ],
        { sha: commit.sha, force: true },
      )
    } catch {
      await this.#api(
        ["-X", "POST", `repos/${slug}/git/refs`, "--input", "-"],
        { ref: `refs/heads/${branch}`, sha: commit.sha },
      )
    }
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
    const proc = new Deno.Command("gh", {
      args,
    }).spawn()

    const { code } = await proc.output()
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
    const proc = new Deno.Command("gh", {
      args,
    }).spawn()

    const { code } = await proc.output()
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

    const toDraft = new Deno.Command("gh", { args: editArgs(true) }).spawn()
    const { code: draftCode } = await toDraft.output()
    if (draftCode !== 0) {
      logger.warning(
        `Failed to set release ${tag} to draft: exit code ${draftCode}`,
      )
      return
    }

    const toPublished = new Deno.Command("gh", { args: editArgs(false) })
      .spawn()
    const { code: publishCode } = await toPublished.output()
    if (publishCode !== 0) {
      logger.warning(
        `Failed to publish release ${tag}: exit code ${publishCode}`,
      )
    }
  }

  async releaseExists(tag: string): Promise<boolean> {
    const args = ["release", "view", tag, "--repo", this.#repo]

    const proc = new Deno.Command("gh", {
      args,
      stdout: "null",
      stderr: "null",
    }).spawn()

    const { code } = await proc.output()
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

      const viewProc = new Deno.Command("gh", {
        args: viewArgs,
        stdout: "piped",
        stderr: "piped",
      })

      const { code: viewCode, stdout: viewStdout } = await viewProc.output()
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

          const deleteProc = new Deno.Command("gh", {
            args: deleteArgs,
          }).spawn()

          const { code: deleteCode } = await deleteProc.output()
          if (deleteCode !== 0) {
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

      const editProc = new Deno.Command("gh", { args: editArgs }).spawn()
      const { code: editCode } = await editProc.output()
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

    const proc = new Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
    })

    const { code, stdout, stderr } = await proc.output()
    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr)
      throw new Error(`Failed to fetch GitHub releases: ${errorText}`)
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

    const proc = new Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
    })

    const { code, stdout, stderr } = await proc.output()
    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr)
      throw new Error(`Failed to download release assets: ${errorText}`)
    }

    const outputText = new TextDecoder().decode(stdout)
    return outputText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim())
  }
}
