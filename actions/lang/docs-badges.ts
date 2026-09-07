import * as path from "@std/path"
import { makeBadge } from "badge-maker"
import logger from "~/util/log.ts"

/**
 * Turns the badge JSON that `docs-publish.ts` assembles into pre-rendered SVGs
 * on the `generated/docs-data` branch.
 *
 * Why render at all, and for every repo rather than just private ones:
 *
 *   - A private repo has no other option. The docs pages and READMEs point
 *     shields.io `endpoint` badges at `raw.githubusercontent.com/<repo>/…`, and
 *     shields fetches that server-side and unauthenticated — a private repo
 *     answers 404, so the badge renders as an error. The one thing that *can*
 *     read a private repo's data is a committed SVG the viewer's own GitHub
 *     session is allowed to load.
 *   - A public repo gains too: a committed SVG is one CDN hop from
 *     raw.githubusercontent.com, versus browser → shields.io → GitHub API →
 *     render for an endpoint badge, so it paints faster and doesn't blank out
 *     during a shields.io incident or rate-limit. Every main build force-pushes
 *     the branch, and these values only move on a build, so the SVG is as fresh
 *     as the endpoint badge was.
 *
 * `badge-maker` is shields.io's own renderer (`npm:badge-maker`), so the output
 * is visually identical to the endpoint badges these stand in for.
 *
 * Kept free of `~/builder.ts` and the network — it takes a directory and a
 * plain data struct — so it can be unit-tested.
 */

/** A shields.io `endpoint` badge body — see the giella-core `make-*.json` scripts. */
type EndpointBadge = {
  schemaVersion?: number
  label?: string
  message?: string | number
  color?: string
}

/**
 * The GitHub-derived values behind the `license` / `issues` / `DocCI` badges.
 * shields.io renders these three itself for public repos (and the docs theme
 * keeps letting it), but its GitHub API calls are unauthenticated and 404 on a
 * private repo — so `docs-publish.ts` looks them up with the CI token and hands
 * them here.
 */
export type RepoBadgeMetadata = {
  /** SPDX id (`GPL-3.0-or-later`), or null for a repo with no detected licence. */
  license: string | null
  /** Open **issues** (not PRs); approximate, refreshed each build. */
  openIssues: number
  /** `conclusion` of the newest `docs.yml` run: `success` / `failure` / … / null. */
  docsConclusion: string | null
}

/**
 * Render `<name>.svg` next to every `<name>.json` in `outDir` that carries a
 * `schemaVersion` (the shields `endpoint` marker): `fst-maturity`,
 * `fst-lemmacount`, `fst-version`, `fst-variants`, `speller-version`,
 * `speller-suggestions` and its `speller-suggestions-<variant>` siblings.
 */
export async function renderEndpointBadgeSvgs(outDir: string): Promise<void> {
  let rendered = 0
  for await (const entry of Deno.readDir(outDir)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue

    let badge: EndpointBadge
    try {
      badge = JSON.parse(await Deno.readTextFile(path.join(outDir, entry.name)))
    } catch {
      continue
    }
    if (badge.schemaVersion == null || badge.message == null) continue

    const svgName = entry.name.replace(/\.json$/, ".svg")
    try {
      await Deno.writeTextFile(
        path.join(outDir, svgName),
        makeBadge({
          label: badge.label ?? "",
          message: String(badge.message),
          color: badge.color ?? "lightgrey",
        }),
      )
      rendered++
    } catch (e) {
      logger.warning(`Could not render ${svgName} from ${entry.name}: ${e}`)
    }
  }
  logger.info(`Rendered ${rendered} endpoint badge SVG(s)`)
}

/**
 * Render `license.svg`, `issues.svg` and `docci.svg` into `outDir` from
 * `meta`. Written for every repo so the branch payload is uniform and no
 * README (a plain Markdown file, so it can't branch on visibility and points
 * every repo at the same SVG URL) is ever left with a dead badge. The values
 * lag to the current build for a public repo, which for a licence, an
 * approximate issue count and a docs-build outcome is immaterial; on a private
 * repo `docci` also trails by one docs run, because publishing the branch is
 * what triggers the next docs build.
 */
export async function renderMetadataBadgeSvgs(
  outDir: string,
  meta: RepoBadgeMetadata,
): Promise<void> {
  const write = async (name: string, fmt: Parameters<typeof makeBadge>[0]) => {
    try {
      await Deno.writeTextFile(path.join(outDir, name), makeBadge(fmt))
    } catch (e) {
      logger.warning(`Could not render ${name}: ${e}`)
    }
  }

  await write("license.svg", {
    label: "license",
    message: meta.license ?? "proprietary",
    color: "blue",
  })
  await write("issues.svg", {
    label: "issues",
    message: `${meta.openIssues} open`,
    color: meta.openIssues > 0 ? "yellow" : "brightgreen",
  })
  await write("docci.svg", {
    label: "DocCI",
    message: docsMessage(meta.docsConclusion),
    color: meta.docsConclusion === "success"
      ? "brightgreen"
      : meta.docsConclusion === "failure"
      ? "red"
      : "lightgrey",
  })
}

function docsMessage(conclusion: string | null): string {
  switch (conclusion) {
    case "success":
      return "passing"
    case "failure":
      return "failing"
    case null:
      return "no runs"
    default:
      return conclusion
  }
}
