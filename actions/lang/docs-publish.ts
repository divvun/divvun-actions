import * as fs from "@std/fs"
import * as path from "@std/path"
import * as yaml from "@std/yaml"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { BuildProps } from "../../pipelines/lang/mod.ts"
import { makeTempDir } from "~/util/temp.ts"
import { readTestlogs, type TestlogsManifest } from "./testlogs.ts"
import {
  buildLogUrl,
  giellaCoreScripts,
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

// --- pkg-variants.json ----------------------------------------------------

const PKG_VARIANTS = "pkg-variants.json"

/**
 * Generate `pkg-variants.json` and upload it as an artifact for the
 * docs-publish step. Called from the speller-build step, the one place the
 * tree is already configured: the file needs configure-substituted make vars
 * (DIALECTS, AREAS, ALT_ORTHS, ...), so it can only come from `make`, and
 * generating it here saves docs-publish from restoring the workspace
 * snapshot, setting up every sibling repo and re-running configure just for
 * this one file. Best-effort: a failure only means the docs site has no
 * variant list for this build.
 */
export async function uploadPkgVariants(): Promise<void> {
  const root = Deno.cwd()
  if (
    !(await run("bash", ["-c", `make -j$(nproc) badgedata/${PKG_VARIANTS}`], {
      cwd: path.join(root, "build", "docs"),
    }))
  ) {
    logger.warning(`Failed to generate ${PKG_VARIANTS}`)
    return
  }

  // VPATH build: the recipe writes to $(srcdir), but fall back to builddir.
  for (const dir of ["docs/badgedata", "build/docs/badgedata"]) {
    if (await fs.exists(path.join(root, dir, PKG_VARIANTS))) {
      try {
        await builder.uploadArtifacts(PKG_VARIANTS, {
          cwd: path.join(root, dir),
        })
      } catch (e) {
        logger.warning(`Failed to upload ${PKG_VARIANTS}: ${e}`)
      }
      return
    }
  }
  logger.warning(`make succeeded but produced no ${PKG_VARIANTS}`)
}

// --- badge + report generation ------------------------------------------

/**
 * Regenerate the badge JSON into `outDir` (plus `speller-accuracy*.json`) by
 * calling the giella-core scripts directly (same invocations as
 * am-shared/docs-dir-include.am). The Class 1 badges (FST + grammar-checker
 * version/rule-count) read the repo's sources and need no build; the
 * `speller-suggestions` badges are derived from the accuracy reports
 * described below; `pkg-variants.json` comes from the speller-build step
 * (`uploadPkgVariants`).
 *
 * The accuracy reports themselves (`speller-accuracy.json` and, for
 * dialect/area/alt-orth/alt-writing-system languages,
 * `speller-accuracy-<code>.json`) are not regenerated here: `make check` in
 * the speller-test step writes them to docs/typosreport/ (suggestion-quality.sh
 * and test-speller-variant-*.sh, using typos-*-generated.tsv and the speller's
 * config.json) and uploads them as artifacts, so the published numbers match
 * a local `make check` by construction.
 */
async function generateDocsData(
  buildConfig: BuildProps,
  scripts: string,
  outDir: string,
): Promise<void> {
  const root = Deno.cwd()

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

  try {
    await builder.downloadArtifacts(PKG_VARIANTS, outDir)
  } catch (e) {
    logger.warning(`No ${PKG_VARIANTS} from the speller-build step: ${e}`)
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

  // Nothing here needs a built or configured tree, or any sibling repo: the
  // badge scripts read this checkout's sources, and everything that does come
  // out of the build (pkg-variants.json, testlogs, accuracy reports) is
  // downloaded as an artifact of the step that made it.

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
  const workDir = (await makeTempDir({ prefix: "docs-data-work-" })).path
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

    await generateDocsData(
      buildConfig,
      await giellaCoreScripts(workDir),
      outDir,
    )
    await buildTestlogs("docs/testlogs", outDir)

    await publishGeneratedDocsData(gh, outDir, repoMeta)
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {})
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}
