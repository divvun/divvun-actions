import * as fs from "@std/fs"
import * as path from "@std/path"
import * as yaml from "@std/yaml"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { BuildProps } from "../../pipelines/lang/mod.ts"
import { makeTempDir } from "~/util/temp.ts"
import { restoreBuiltWorkspace } from "./common.ts"
import { readTestlogs, type TestlogsManifest } from "./testlogs.ts"
import {
  buildLogUrl,
  gutRepoName,
  publishGeneratedDocsData,
  run,
} from "~/actions/common/docs-data.ts"

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

/**
 * Regenerate the badge JSON into `outDir` (plus `speller-accuracy*.json`) by
 * calling the giella-core scripts directly (same invocations as
 * am-shared/docs-dir-include.am). The Class 1 badges (FST + grammar-checker
 * version/rule-count) need no FST build; the `speller-suggestions` badges are
 * derived from the accuracy reports described below.
 *
 * The accuracy reports themselves (`speller-accuracy.json` and, for
 * dialect/area/alt-orth/alt-writing-system languages,
 * `speller-accuracy-<code>.json`) are not regenerated here: `make check` in
 * the speller-test step writes them to docs/typosreport/ (suggestion-quality.sh
 * and test-speller-variant-*.sh, using typos-*-generated.tsv and the speller's
 * config.json) and uploads them as artifacts, so the published numbers match
 * a local `make check` by construction.
 *
 * TODO(CI): `pkg-variants.json` needs autoconf-substituted vars (DIALECTS,
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
  await emit("pkg-maturity.json", "bash", [
    path.join(scripts, "make-maturity.json.sh"),
    await gutRepoName(),
  ])
  await emit("pkg-version.json", "bash", [
    path.join(scripts, "make-version-json.sh"),
    root,
    "FST",
  ])
  await emit("speller-version.json", "bash", [
    path.join(scripts, "make-version-json.sh"),
    root,
    "SPELLER",
  ])

  await emit("gramcheck-version.json", "bash", [
    path.join(scripts, "make-version-json.sh"),
    root,
    "GRAMCHECK",
  ])
  await emit("gramcheck-rules.json", "bash", [
    path.join(scripts, "make-gramcheck-rules-json.sh"),
    root,
  ])

  // pkg-variants.json needs configure-substituted make vars, so go through make.
  if (
    await run("bash", ["-c", "make -j$(nproc) badgedata/pkg-variants.json"], {
      cwd: path.join(root, "build", "docs"),
    })
  ) {
    // VPATH build: make may land it in builddir or (fallback) srcdir.
    const made = [
      "build/docs/badgedata/pkg-variants.json",
      "docs/badgedata/pkg-variants.json",
    ]
    let copied = false
    for (const cand of made) {
      if (await fs.exists(cand)) {
        await Deno.copyFile(cand, path.join(outDir, "pkg-variants.json"))
        copied = true
        break
      }
    }
    if (!copied) {
      logger.warning("make succeeded but produced no pkg-variants.json")
    }
  } else {
    logger.warning("Failed to generate pkg-variants.json")
  }

  if (buildConfig.spellers) {
    const srcTyposreport = path.join(root, "docs", "typosreport")
    const reports: string[] = []
    try {
      for await (const entry of Deno.readDir(srcTyposreport)) {
        const m = entry.isFile && entry.name.match(/^report(-.+)?\.json$/)
        if (!m) continue
        const suffix = m[1] ?? ""
        const reportOut = path.join(outDir, `speller-accuracy${suffix}.json`)
        await Deno.copyFile(path.join(srcTyposreport, entry.name), reportOut)
        await emit(`speller-suggestions${suffix}.json`, "bash", [
          path.join(scripts, "make-spellerbadge-json.sh"),
          reportOut,
        ])
        reports.push(entry.name)
      }
    } catch { /* dir doesn't exist — handled below */ }
    if (reports.length > 0) {
      logger.info(`Published speller accuracy report(s): ${reports.join(", ")}`)
    } else {
      logger.warning("No speller accuracy reports from the speller-test step")
    }
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

  const gh = new GitHub(builder.env.repo)

  // One round-trip for repo visibility (which selects the private publishing
  // path below) and the license / issues / DocCI badge inputs.
  const repoMeta = await gh.repoMetadata()

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
    // docs/typosreport/*.json likewise come from `make check` in the test
    // step; see generateDocsData.
    try {
      await builder.downloadArtifacts("docs/typosreport/*.json", ".")
    } catch (e) {
      logger.warning(`No typosreport artifacts: ${e}`)
    }

    await generateDocsData(buildConfig, outDir)
    await buildTestlogs("docs/testlogs", outDir)

    await publishGeneratedDocsData(gh, outDir, repoMeta)
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {})
  }
}
