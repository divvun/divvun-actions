import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import {
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
 * `actions/lang/docs-publish.ts` this needs no build/snapshot-restore
 * preamble — just a checkout of the repo (already done by Buildkite) and, for
 * everything except giella-core itself, a shallow sibling clone of
 * giella-core for its `scripts/`.
 *
 * Shares its publish tail (`publishGeneratedDocsData`) with the lang-
 * producer so there is exactly one implementation of the badge SVG rendering
 * and `generated/docs-data` publish logic, regardless of repo type. See
 * docs/badgedata-artifact-migration.md.
 */
async function resolveGiellaCoreScripts(): Promise<string> {
  if (builder.env.repoName === "giella-core") {
    return path.join(Deno.cwd(), "scripts")
  }

  const giellaCorePath = path.join(Deno.cwd(), "..", "giella-core")
  if (!(await fs.exists(giellaCorePath))) {
    // Same-scheme/host/owner as this repo's own origin, so the clone rides on
    // whatever credential (ssh key, token) already fetched it.
    const origin = await new Deno.Command("git", {
      args: ["remote", "get-url", "origin"],
      cwd: Deno.cwd(),
    }).output()
    const originUrl = new TextDecoder().decode(origin.stdout).trim()
    const url = originUrl.replace(/[^/:]+?(\.git)?$/, "giella-core.git")

    logger.info(`Cloning giella-core (shallow) from ${url}`)
    const clone = new Deno.Command("git", {
      args: ["clone", "--depth", "1", url, giellaCorePath],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn()
    if ((await clone.status).code !== 0) {
      throw new Error("Failed to clone giella-core")
    }
  }

  return path.join(giellaCorePath, "scripts")
}

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
  try {
    const scripts = await resolveGiellaCoreScripts()
    const root = Deno.cwd()

    const emit = async (name: string, args: string[]) => {
      if (await run("bash", args, { outFile: path.join(outDir, name) })) {
        return
      }
      logger.warning(`Failed to generate ${name}`)
    }

    await emit("version.json", [
      path.join(scripts, "make-version-json.sh"),
      root,
      "FST",
    ])
    await emit("fst-lemmacount.json", [
      path.join(scripts, "make-lemmacount.json.sh"),
      root,
    ])
    await emit("fst-maturity.json", [
      path.join(scripts, "make-maturity.json.sh"),
      await gutRepoName(),
    ])

    await publishGeneratedDocsData(gh, outDir, repoMeta)
  } finally {
    await Deno.remove(outDir, { recursive: true }).catch(() => {})
  }
}
