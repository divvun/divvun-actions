import * as fs from "@std/fs"
import * as path from "@std/path"
import * as yaml from "@std/yaml"
import * as builder from "~/builder.ts"
import { GitHub, GitHubApiError } from "~/util/github.ts"
import { ExpectedError } from "~/util/error.ts"
import logger from "~/util/log.ts"
import { BuildProps } from "../../pipelines/lang/mod.ts"
import { makeTempDir } from "~/util/temp.ts"
import { restoreBuiltWorkspace } from "./common.ts"
import { readTestlogs, type TestlogsManifest } from "./testlogs.ts"

/**
 * Rolling orphan branch the docs site + README badges read from, via
 * `raw.githubusercontent.com/<repo>/generated/docs-data/<file>` (the one GitHub
 * host that sends `access-control-allow-origin: *`, so the browser can
 * `fetch()` it). Force-pushed on every `main` build — one commit, no history.
 * The `generated/` prefix makes git clients fold it into one collapsible
 * folder. See docs/badgedata-artifact-migration.md.
 */
const DOCS_DATA_BRANCH = "generated/docs-data"

/**
 * Link to this build's log. The docs pages are public, so point at the
 * `builds.giellalt.org` mirror rather than `buildkite.com` (which needs a
 * Buildkite org seat to view).
 */
function buildLogUrl(): string | null {
  const slug = builder.env.pipelineSlug ?? builder.env.repoName
  return builder.env.buildNumber
    ? `https://builds.giellalt.org/pipelines/${slug}/builds/${builder.env.buildNumber}`
    : null
}

// --- testlogs.json --------------------------------------------------------

/**
 * From the per-suite JSON that `gtlemmatest`/`gtspelltest -J` wrote during
 * `make check`, write `testlogs.json` (small manifest, one summary row per
 * suite) plus one `testlogs-<id>.json` (full failure list) per failing suite
 * into `outDir`. The docs page loads the manifest, then fetches a suite's file
 * only when opened, so no single request is large even for a badly broken
 * build.
 */
async function buildTestlogs(
  testlogsDir: string,
  outDir: string,
): Promise<void> {
  const { summaries, details } = await readTestlogs(testlogsDir)

  const manifest: TestlogsManifest = {
    generated: new Date().toISOString(),
    commit: builder.env.commit ?? null,
    build_url: buildLogUrl(),
    suites: summaries,
  }

  await Deno.writeTextFile(
    path.join(outDir, "testlogs.json"),
    JSON.stringify(manifest),
  )

  for (const detail of details) {
    await Deno.writeTextFile(
      path.join(outDir, `testlogs-${detail.id}.json`),
      JSON.stringify(detail),
    )
  }
}

// --- badge + report generation ------------------------------------------

const GTCORE = path.join("..", "giella-core")

async function run(
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
async function repoName(): Promise<string> {
  try {
    const toml = await Deno.readTextFile(".gut/delta.toml")
    const m = toml.match(/__REPO__\s*=\s*"([^"]+)"/)
    if (m) return m[1]
  } catch { /* fall through */ }
  return builder.env.repoName
}

/**
 * Regenerate the badge JSON + `speller-accuracy.json` into `outDir` by
 * calling the giella-core scripts directly (same invocations as
 * am-shared/docs-dir-include.am). The Class 1 badges need no FST build;
 * `speller-accuracy.json` and the `speller-suggestions` badge derived from
 * it need the built speller, which the snapshot restores.
 *
 * Variant accuracy reports (`speller-accuracy-<code>.json`, for
 * dialect/area/alt-orth/alt-writing-system languages) come from
 * giella-core's `speller-variant-reports` target
 * (am-shared/tools-spellcheckers-test-include.am, included from
 * tools/spellcheckers/test/Makefile.am) — it writes `report.json` /
 * `report-<code>.json` straight into docs/typosreport/ in the source tree
 * (not build/), one per configured dialect/area/orthography/writing-system.
 * When it ran, its report.json also folds in variant-specific typos data via
 * typos-default-generated.tsv, so it's a strictly better default report than
 * the plain build/docs/report.json below for multi-variant repos — prefer it
 * when present. Soft-fail throughout: most repos have no variants, and the
 * target is a cheap no-op there.
 *
 * TODO(CI): `fst-variants.json` needs autoconf-substituted vars (DIALECTS,
 * AREAS, ...) — generated via `make` below; verify the target name against a
 * real build.
 */
async function generateDocsData(
  buildConfig: BuildProps,
  outDir: string,
): Promise<void> {
  const root = Deno.cwd()
  const scripts = path.join(GTCORE, "scripts")

  const emit = async (name: string, cmd: string, args: string[]) => {
    if (await run(cmd, args, { outFile: path.join(outDir, name) })) return
    logger.warning(`Failed to generate ${name}`)
  }

  await emit("fst-lemmacount.json", "bash", [
    path.join(scripts, "make-lemmacount.json.sh"),
    root,
  ])
  await emit("fst-maturity.json", "bash", [
    path.join(scripts, "make-maturity.json.sh"),
    await repoName(),
  ])
  await emit("fst-version.json", "bash", [
    path.join(scripts, "make-version-json.sh"),
    root,
    "FST",
  ])
  await emit("speller-version.json", "bash", [
    path.join(scripts, "make-version-json.sh"),
    root,
    "SPELLER",
  ])

  // fst-variants.json needs configure-substituted make vars, so go through make.
  if (
    await run("bash", ["-c", "make -j$(nproc) badgedata/fst-variants.json"], {
      cwd: path.join(root, "build", "docs"),
    })
  ) {
    // VPATH build: make may land it in builddir or (fallback) srcdir.
    const made = [
      "build/docs/badgedata/fst-variants.json",
      "docs/badgedata/fst-variants.json",
    ]
    let copied = false
    for (const cand of made) {
      if (await fs.exists(cand)) {
        await Deno.copyFile(cand, path.join(outDir, "fst-variants.json"))
        copied = true
        break
      }
    }
    if (!copied) {
      logger.warning("make succeeded but produced no fst-variants.json")
    }
  } else {
    logger.warning("Failed to generate fst-variants.json")
  }

  if (buildConfig.spellers) {
    const reportOut = path.join(outDir, "speller-accuracy.json")
    const srcTyposreport = path.join(root, "docs", "typosreport")

    // Variant reports first: for a multi-variant repo this also produces the
    // more complete default docs/typosreport/report.json (see doc comment
    // above), which the fallback below should not then clobber.
    const variantsDir = path.join(
      root,
      "build",
      "tools",
      "spellcheckers",
      "test",
    )
    let variantReportCount = 0
    if (await fs.exists(variantsDir)) {
      if (
        await run("bash", ["-c", "make -j$(nproc) speller-variant-reports"], {
          cwd: variantsDir,
        })
      ) {
        try {
          for await (const entry of Deno.readDir(srcTyposreport)) {
            const m = entry.isFile && entry.name.match(/^report-(.+)\.json$/)
            if (!m) continue
            await Deno.copyFile(
              path.join(srcTyposreport, entry.name),
              path.join(outDir, `speller-accuracy-${m[1]}.json`),
            )
            variantReportCount++
          }
        } catch {
          // No docs/typosreport dir — speller-variant-reports was a no-op
          // (repo has no dialects/areas/orthographies/writing systems).
        }
        if (variantReportCount > 0) {
          logger.info(
            `Published ${variantReportCount} variant accuracy report(s)`,
          )
        }
      } else {
        logger.warning(
          "speller-variant-reports failed (or this repo has no variants configured)",
        )
      }
    }

    const variantDefaultReport = path.join(srcTyposreport, "report.json")
    if (variantReportCount > 0 && await fs.exists(variantDefaultReport)) {
      await Deno.copyFile(variantDefaultReport, reportOut)
    } else if (
      await run("bash", ["-c", "make -j$(nproc) report.json"], {
        cwd: path.join(root, "build", "docs"),
      }) && await fs.exists("build/docs/report.json")
    ) {
      await Deno.copyFile("build/docs/report.json", reportOut)
    } else {
      logger.warning("Failed to generate speller-accuracy.json")
    }

    if (await fs.exists(reportOut)) {
      await emit("speller-suggestions.json", "bash", [
        path.join(scripts, "make-spellerbadge-json.sh"),
        reportOut,
      ])
    }

    // Hygiene: docs/typosreport/*.json is already .gitignore'd in every lang
    // repo, so this isn't needed for git cleanliness — just to avoid stale
    // generated files lingering in a workspace reused across builds.
    try {
      for await (const entry of Deno.readDir(srcTyposreport)) {
        if (entry.isFile && /^report(-.+)?\.json$/.test(entry.name)) {
          await Deno.remove(path.join(srcTyposreport, entry.name))
        }
      }
    } catch { /* dir doesn't exist — nothing to clean up */ }
  }
}

// --- entry point --------------------------------------------------------

export async function runLangDocsPublish() {
  if (builder.env.branch !== "main") {
    logger.info(`Not on main (branch: ${builder.env.branch}); skipping.`)
    return
  }

  const config = await yaml.parse(
    await Deno.readTextFile(".build-config.yml"),
  ) as { build?: BuildProps }
  const buildConfig = config?.build ?? {} as BuildProps

  // Restore the same built + configured tree the speller-test step uses.
  await restoreBuiltWorkspace("speller-configure-flags")

  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  // Everything to publish is assembled in one throwaway directory, flat, under
  // its final name — nothing is written into the checkout's tracked paths.
  const outDir = (await makeTempDir({ prefix: "docs-data-" })).path
  try {
    // testlogs/*-lemmas.json are produced by `make check` in the test step
    // (gtlemmatest/gtspelltest -J), which uploads them as artifacts. A repo
    // with no morphology/speller tests uploads nothing — that's fine, the
    // manifest is just empty.
    try {
      await builder.downloadArtifacts("docs/testlogs/*-lemmas.json", ".")
    } catch (e) {
      logger.warning(`No testlogs artifacts: ${e}`)
    }

    await generateDocsData(buildConfig, outDir)
    await buildTestlogs("docs/testlogs", outDir)

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
    // `[skip ci]` so the push doesn't spawn a (doomed) lang build on that
    // branch — Buildkite honours it in the HEAD commit message. Without it the
    // repo's CI status badge would flip to that failure.
    const gh = new GitHub(builder.env.repo)
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
      // build, and a silent skip would hide a whole language's badges going
      // stale. See docs/badgedata-artifact-migration.md.
      if (
        e instanceof GitHubApiError && (e.status === 404 || e.status === 403)
      ) {
        throw ExpectedError.create(
          `Cannot publish ${DOCS_DATA_BRANCH} to ${builder.env.repo}: ` +
            `divvunbot has no write access (HTTP ${e.status}). ` +
            `Fix: give the repo the "GiellaLTstaff" team with write permission ` +
            `(Settings → Collaborators and teams), or add another team ` +
            `divvunbot belongs to. This is required for every new lang- repo.`,
        )
      }
      throw e
    }

    logger.info("Docs data published")
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {})
  }
}
