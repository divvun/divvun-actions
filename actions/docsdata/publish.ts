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
 * itself, and `template-*`. These only ever need the package version and
 * maturity badges, which `make-version-json.sh` / `make-maturity.json.sh`
 * produce by reading `configure.ac` and the GitHub topics API directly. None
 * of that needs `./configure` or `make` to have run, so unlike
 * `actions/lang/docs-publish.ts` this needs no build artifacts — just a
 * checkout of the repo (already done by Buildkite) and, for everything except
 * giella-core itself, a shallow clone of giella-core for its `scripts/`
 * (`giellaCoreScripts`).
 *
 * No lemma count: only lang- repos' counts are shown anywhere (README, docs
 * badge row, the giellalt.github.io lang tables), and the lang- pipeline
 * publishes those.
 *
 * No maturity badge for `template-*`: a template has no maturity of its own
 * (none carries a `maturity-*` topic, so the badge always said Undefined),
 * and nothing displays a template's badges.
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
      "PKG",
    ])
    if (!builder.env.repoName.startsWith("template-")) {
      await emit("pkg-maturity.json", [
        path.join(scripts, "make-maturity.json.sh"),
        await gutRepoName(),
      ])
    }

    await publishGeneratedDocsData(gh, outDir, repoMeta)
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {})
    await Deno.remove(workDir, { recursive: true }).catch(() => {})
  }
}
