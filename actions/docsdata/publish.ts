import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import {
  giellaCoreScripts,
  gutRepoName,
  publishGeneratedDocsData,
  run,
} from "~/actions/common/docs-data.ts"

/**
 * Publish `generated/docs-data` for the giella-core family of repos that
 * don't build an FST or speller: `shared-*` (lexicon fragments), `giella-core`
 * itself, and `template-*`. These only ever need the "Class 1" badges — FST
 * version, lemma count, maturity — which `make-version-json.sh` /
 * `make-lemmacount.json.sh` / `make-maturity.json.sh` produce by reading
 * `configure.ac`, the lexc source and the GitHub topics API directly. None of
 * that needs `./configure` or `make` to have run, so unlike
 * `actions/lang/docs-publish.ts` this needs no build artifacts — just a
 * checkout of the repo (already done by Buildkite) and, for everything except
 * giella-core itself, a shallow clone of giella-core for its `scripts/`
 * (`giellaCoreScripts`).
 *
 * Shares its publish tail (`publishGeneratedDocsData`) with the lang-
 * producer so there is exactly one implementation of the badge SVG rendering
 * and `generated/docs-data` publish logic, regardless of repo type. See
 * docs/badgedata-artifact-migration.md.
 */
export async function runDocsDataPublish() {
  if (builder.env.branch !== "main") {
    logger.info(`Not on main (branch: ${builder.env.branch}); skipping.`)
    return
  }

  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  const gh = new GitHub(builder.env.repo)
  const repoMeta = await gh.repoMetadata()

  const outDir = (await makeTempDir({ prefix: "docs-data-" })).path
  const workDir = (await makeTempDir({ prefix: "docs-data-work-" })).path
  try {
    const scripts = await giellaCoreScripts(workDir)
    const root = Deno.cwd()

    const emit = async (name: string, args: string[]) => {
      if (await run("bash", args, { outFile: path.join(outDir, name) })) {
        return
      }
      logger.warning(`Failed to generate ${name}`)
    }

    await emit("pkg-version.json", [
      path.join(scripts, "make-version-json.sh"),
      root,
      "FST",
    ])
    await emit("fst-lemmacount.json", [
      path.join(scripts, "make-lemmacount.json.sh"),
      root,
    ])
    await emit("pkg-maturity.json", [
      path.join(scripts, "make-maturity.json.sh"),
      await gutRepoName(),
    ])

    await publishGeneratedDocsData(gh, outDir, repoMeta)
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {})
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}
