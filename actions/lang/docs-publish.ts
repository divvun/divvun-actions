import * as fs from "@std/fs"
import * as path from "@std/path"
import * as yaml from "@std/yaml"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { BuildProps } from "../../pipelines/lang/mod.ts"
import {
  downloadAndExtractSpellerSnapshot,
  setupGiellaCoreDependencies,
} from "./common.ts"
import { readTestlogs, type TestlogsManifest } from "./testlogs.ts"

/**
 * Rolling release the docs site + README badges read from. Updated in place on
 * every `main` build — same pattern as the `speller-<lang>/dev-latest`
 * nightlies. See docs/badgedata-artifact-migration.md.
 */
const DOCS_RELEASE_TAG = "docs-latest"

// --- testlogs.json --------------------------------------------------------

/**
 * From the per-suite JSON that `gtlemmatest`/`gtspelltest -J` wrote during
 * `make check`, produce `testlogs.json` (small manifest, one summary row per
 * suite) and one `testlogs-<id>.json` (full failure list) per failing suite.
 * The docs page loads the manifest, then fetches a suite's file only when
 * opened, so no single request is large even for a badly broken build.
 * Returns the list of files written.
 */
async function buildTestlogs(testlogsDir: string): Promise<string[]> {
  const org = builder.env.organizationSlug ?? "divvun"
  const slug = builder.env.pipelineSlug ?? builder.env.repoName
  const buildUrl = builder.env.buildNumber
    ? `https://buildkite.com/${org}/${slug}/builds/${builder.env.buildNumber}`
    : null

  const { summaries, details } = await readTestlogs(testlogsDir)

  const manifest: TestlogsManifest = {
    generated: new Date().toISOString(),
    commit: builder.env.commit ?? null,
    build_url: buildUrl,
    suites: summaries,
  }

  const files = ["testlogs.json"]
  await Deno.writeTextFile("testlogs.json", JSON.stringify(manifest))

  for (const detail of details) {
    const name = `testlogs-${detail.id}.json`
    await Deno.writeTextFile(name, JSON.stringify(detail))
    files.push(name)
  }

  return files
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
 * Regenerate the badge JSON + `report.json` from the built + configured tree by
 * calling the giella-core scripts directly (same invocations as
 * am-shared/docs-dir-include.am). The Class 1 badges need no FST build;
 * `report.json` and the `speller-suggestions` badge derived from it need the
 * built speller, which the snapshot restores.
 *
 * TODO(CI): `fst-variants.json` needs autoconf-substituted vars (DIALECTS,
 * AREAS, ...) — generated via `make` below; verify the target name against a
 * real build. Variant reports (`report-<v>.json` /
 * `speller-suggestions-<v>.json`) for dialect/area/alt-orth languages are not
 * handled yet — see giella-core's `speller-variant-reports` target.
 */
async function generateDocsData(buildConfig: BuildProps): Promise<string[]> {
  const assets: string[] = []
  const badgeDir = "docs/badgedata"
  await fs.ensureDir(badgeDir)
  const root = Deno.cwd()
  const scripts = path.join(GTCORE, "scripts")

  const emit = async (
    name: string,
    cmd: string,
    args: string[],
  ) => {
    const out = path.join(badgeDir, name)
    if (await run(cmd, args, { outFile: out })) {
      assets.push(out)
    } else {
      logger.warning(`Failed to generate ${name}`)
    }
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
    for (
      const cand of [
        "build/docs/badgedata/fst-variants.json",
        "docs/badgedata/fst-variants.json",
      ]
    ) {
      if (await fs.exists(cand)) {
        if (cand !== "docs/badgedata/fst-variants.json") {
          await Deno.copyFile(cand, "docs/badgedata/fst-variants.json")
        }
        assets.push("docs/badgedata/fst-variants.json")
        break
      }
    }
  } else {
    logger.warning("Failed to generate fst-variants.json")
  }

  if (buildConfig.spellers) {
    const report = "docs/typosreport/report.json"
    await fs.ensureDir("docs/typosreport")
    if (
      await run("bash", ["-c", "make -j$(nproc) report.json"], {
        cwd: path.join(root, "build", "docs"),
      }) && await fs.exists("build/docs/report.json")
    ) {
      await Deno.copyFile("build/docs/report.json", report)
      assets.push(report)
      await emit("speller-suggestions.json", "bash", [
        path.join(scripts, "make-spellerbadge-json.sh"),
        report,
      ])
    } else {
      logger.warning("Failed to generate report.json")
    }
  }

  return assets
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

  // Restore the built + configured workspace (same preamble as the test step).
  await downloadAndExtractSpellerSnapshot()
  await setupGiellaCoreDependencies()

  const configureFlags = await builder.metadata("speller-configure-flags")
  const configure = new Deno.Command("bash", {
    args: ["-c", `../configure ${configureFlags}`],
    cwd: path.join(Deno.cwd(), "build"),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  if ((await configure.status).code !== 0) {
    throw new Error("configure failed")
  }

  // testlogs/*-lemmas.json are produced by `make check` in the test step
  // (gtlemmatest/gtspelltest -J), which uploads them as artifacts. A repo with
  // no morphology/speller tests uploads nothing — that's fine, the manifest is
  // just empty.
  try {
    await builder.downloadArtifacts("docs/testlogs/*-lemmas.json", ".")
  } catch (e) {
    logger.warning(`No testlogs artifacts: ${e}`)
  }

  const badgeAssets = await generateDocsData(buildConfig)
  const testlogAssets = await buildTestlogs("docs/testlogs")

  const assets = [...badgeAssets, ...testlogAssets]
  logger.info(`Publishing ${assets.length} assets to ${DOCS_RELEASE_TAG}:`)
  for (const a of assets) logger.info(`  ${a}`)

  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  // updateRelease creates the docs-latest tag on first run and thereafter just
  // swaps the assets. The tag then points at that first commit forever, which
  // is cosmetic: the releases/download/docs-latest/<file> URLs resolve via the
  // release regardless, and testlogs.json carries the real `commit`.
  const gh = new GitHub(builder.env.repo)
  await gh.updateRelease(DOCS_RELEASE_TAG, assets, {
    draft: false,
    prerelease: true,
    name: "Docs data (latest main build)",
  })

  logger.info("Docs data published")
}
