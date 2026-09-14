import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { GitHub, GitHubApiError } from "~/util/github.ts"
import { ExpectedError } from "~/util/error.ts"
import logger from "~/util/log.ts"
import {
  renderEndpointBadgeSvgs,
  renderMetadataBadgeSvgs,
  type RepoBadgeMetadata,
} from "~/actions/lang/docs-badges.ts"

/**
 * Rolling orphan branch the docs site + README badges read from, via
 * `raw.githubusercontent.com/<repo>/generated/docs-data/<file>` (the one GitHub
 * host that sends `access-control-allow-origin: *`, so the browser can
 * `fetch()` it). Force-pushed on every `main` build — one commit, no history.
 * The `generated/` prefix makes git clients fold it into one collapsible
 * folder. See docs/badgedata-artifact-migration.md.
 *
 * Every repo family that publishes docs data (lang-, and the lighter
 * shared-/giella-core/template- family in `actions/docsdata/publish.ts`)
 * writes to this same branch name on its own repo, through the same
 * `publishGeneratedDocsData` below — one producer implementation regardless
 * of repo type.
 */
export const DOCS_DATA_BRANCH = "generated/docs-data"

/**
 * Link to this build's log. The docs pages are public, so point at the
 * `builds.giellalt.org` mirror rather than `buildkite.com` (which needs a
 * Buildkite org seat to view).
 */
export function buildLogUrl(): string | null {
  const slug = builder.env.pipelineSlug ?? builder.env.repoName
  return builder.env.buildNumber
    ? `https://builds.giellalt.org/pipelines/${slug}/builds/${builder.env.buildNumber}`
    : null
}

/** Run a command, optionally capturing stdout to a file. Returns success. */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; outFile?: string } = {},
): Promise<boolean> {
  const proc = new Deno.Command(cmd, {
    args,
    cwd: opts.cwd,
    stdout: opts.outFile ? "piped" : "inherit",
    stderr: "inherit",
  })
  if (opts.outFile) {
    const { code, stdout } = await proc.output()
    if (code === 0) await Deno.writeFile(opts.outFile, stdout)
    return code === 0
  }
  return (await proc.spawn().status).code === 0
}

/** giella-core's docs-dir-include.am derives REPONAME from .gut/delta.toml. */
export async function gutRepoName(): Promise<string> {
  try {
    const toml = await Deno.readTextFile(".gut/delta.toml")
    const m = toml.match(/__REPO__\s*=\s*"([^"]+)"/)
    if (m) return m[1]
  } catch { /* fall through */ }
  return builder.env.repoName
}

/**
 * Finish assembling `outDir` (badge SVGs + `meta.json`) and force-push it to
 * `generated/docs-data` as a fresh orphan commit. Shared tail for every
 * docs-data producer — see `DOCS_DATA_BRANCH` above.
 */
export async function publishGeneratedDocsData(
  gh: GitHub,
  outDir: string,
  repoMeta: RepoBadgeMetadata & { private: boolean },
): Promise<void> {
  // Pre-render the FST/speller badges as SVGs alongside their JSON: a private
  // repo can't use shields.io `endpoint` badges (shields fetches the JSON
  // server-side and unauthenticated → 404), and a public repo loads a
  // committed SVG faster and without a shields.io dependency. The
  // license/issues/DocCI SVGs only stand in where shields.io can't reach the
  // repo, so a public build skips them. See docs-badges.ts.
  await renderEndpointBadgeSvgs(outDir)
  if (repoMeta.private) {
    await renderMetadataBadgeSvgs(outDir, repoMeta)
  }

  // Provenance for the docs pages (they show "data from <commit>, <n> ago").
  await Deno.writeTextFile(
    path.join(outDir, "meta.json"),
    JSON.stringify({
      generated: new Date().toISOString(),
      commit: builder.env.commit ?? null,
      build_url: buildLogUrl(),
    }),
  )

  const files: Array<{ path: string; source: string }> = []
  for await (const entry of Deno.readDir(outDir)) {
    if (entry.isFile) {
      files.push({ path: entry.name, source: path.join(outDir, entry.name) })
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))

  logger.info(`Publishing ${files.length} files to ${DOCS_DATA_BRANCH}:`)
  for (const f of files) logger.info(`  ${f.path}`)

  // Force-push a fresh orphan commit: the branch is a transport buffer for
  // the latest build's data, not an archive. Files land at the branch root,
  // so the raw URL is `.../<repo>/generated/docs-data/<name>`.
  // `[skip ci]` so the push doesn't spawn a (doomed) build on that branch —
  // Buildkite honours it in the HEAD commit message. Without it the repo's
  // CI status badge would flip to that failure.
  try {
    await gh.publishBranch(DOCS_DATA_BRANCH, files, {
      orphan: true,
      message: `docs data: ${builder.env.commit?.slice(0, 8) ?? "?"} (build ${
        builder.env.buildNumber ?? "?"
      }) [skip ci]`,
    })
  } catch (e) {
    // A 404/403 on the Git Data API write means the CI identity (divvunbot)
    // can't push to this repo. divvunbot gets write access through the
    // `GiellaLTstaff` / `GiellaLTusers` teams; a repo created without one of
    // those teams (or with only a project/regional team) hits this. GitHub
    // masks "authenticated but no write access" as 404 on write endpoints, so
    // the raw error is misleading — spell the cause out. Still fatal: this is
    // `soft_fail` in the pipeline, so it stays visible without blocking the
    // build, and a silent skip would hide a whole repo's badges going stale.
    // See docs/badgedata-artifact-migration.md.
    if (
      e instanceof GitHubApiError && (e.status === 404 || e.status === 403)
    ) {
      throw ExpectedError.create(
        `Cannot publish ${DOCS_DATA_BRANCH} to ${builder.env.repo}: ` +
          `divvunbot has no write access (HTTP ${e.status}). ` +
          `Fix: give the repo the "GiellaLTstaff" team with write permission ` +
          `(Settings → Collaborators and teams), or add another team ` +
          `divvunbot belongs to. This is required for every new repo.`,
      )
    }
    throw e
  }

  logger.info("Docs data published")

  // A public repo's docs page fetches `generated/docs-data` live from
  // raw.githubusercontent.com, so the push above is enough. A private repo
  // can't do that (auth required, no CORS header), so its docs workflow
  // embeds a copy of the branch at build time — which means the site only
  // updates when it rebuilds. Kick that rebuild now.
  if (repoMeta.private) {
    try {
      await gh.dispatchDocsWorkflow()
    } catch (e) {
      logger.warning(`Could not trigger docs rebuild: ${e}`)
    }
  }
}
