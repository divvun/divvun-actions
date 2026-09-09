import * as path from "@std/path"
import { makeBadge } from "badge-maker"
import logger from "~/util/log.ts"

/**
 * Turns the badge JSON that `docs-publish.ts` assembles into pre-rendered SVGs
 * on the `generated/docs-data` branch.
 *
 * The FST/speller endpoint badges (`renderEndpointBadgeSvgs`) are rendered for
 * every repo:
 *
 *   - A private repo has no other option. The docs pages point shields.io
 *     `endpoint` badges at `raw.githubusercontent.com/<repo>/…`, and shields
 *     fetches that server-side and unauthenticated — a private repo answers
 *     404, so the badge renders as an error. The one thing that *can* read a
 *     private repo's data is a committed SVG the viewer's own GitHub session is
 *     allowed to load.
 *   - A public repo gains too: a committed SVG is one CDN hop from
 *     raw.githubusercontent.com, versus browser → shields.io → GitHub API →
 *     render for an endpoint badge, so it paints faster and doesn't blank out
 *     during a shields.io incident or rate-limit. Every main build force-pushes
 *     the branch, and these values only move on a build, so the SVG is as fresh
 *     as the endpoint badge was.
 *
 * The license/issues/DocCI badges (`renderMetadataBadgeSvgs`) are rendered for
 * private repos only — that's the one case where shields.io can't reach the
 * GitHub API for them; a public build keeps letting shields render those live.
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
 * The GitHub-derived values behind the `license` / `issues` / `DocCI` badges,
 * looked up by `GitHub.repoMetadata()` and only for a private repo (where
 * shields.io's unauthenticated API calls would 404).
 */
export type RepoBadgeMetadata = {
  /** SPDX id (`GPL-3.0-or-later`), or null for a repo with no detected licence. */
  license: string | null
  /** Open **issues** (not PRs); approximate, refreshed each build. */
  openIssues: number
  /** `conclusion` of the newest completed `docs.yml` run: `success` / `failure` / … / null. */
  docsConclusion: string | null
}

/**
 * Render `<name>.svg` next to every `<name>.json` in `outDir` that carries a
 * `schemaVersion` (the shields `endpoint` marker): `fst-maturity`,
 * `fst-lemmacount`, `fst-version`, `speller-version`, `speller-suggestions` and
 * its `speller-suggestions-<variant>` siblings, `gramcheck-version` and
 * `gramcheck-rules`. `fst-variants.json` and the `speller-accuracy*.json` /
 * `testlogs*.json` data files have no `schemaVersion` and are skipped.
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
 * Render `license.svg`, `issues.svg` and `docci.svg` into `outDir` from `meta`.
 * `docs-publish.ts` calls this for private repos only — where the docs theme
 * reads these three off the branch because shields.io can't reach the GitHub
 * API for a private repo. The values are as of this build; `docci` in
 * particular trails by one docs run, because publishing the branch is what
 * triggers the next docs build.
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
