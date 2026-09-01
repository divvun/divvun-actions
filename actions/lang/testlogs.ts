import * as fs from "@std/fs"
import * as path from "@std/path"

/**
 * Reads the per-suite JSON that giella-core's lemma / speller tests write during
 * `make check` (gtlemmatest / gtspelltest `-J`, GiellaLTLexTools >= 0.10.0) and
 * turns it into what the docs site consumes: a small `testlogs.json` manifest
 * plus one `testlogs-<id>.json` per suite with failures.
 *
 * Kept free of `~/builder.ts` so it can be unit-tested.
 * See docs/badgedata-artifact-migration.md.
 */

// --- gtlemmatest / gtspelltest -J output ---------------------------------

type LemmaFailure = {
  lemma: string
  no_generation: string[]
  wrong_generation: Array<{ expected: string; got: string }>
  analyses: string[]
}

type SpellFailure = { lemma: string; suggestions: string[] }

type LemmaSuiteJson = {
  pos: string
  lexc: string
  lemmas: number
  tested: number
  success_pct: number
  truncated: boolean
  failures: LemmaFailure[]
}

type SpellSuiteJson = {
  lemmas: number
  tested: number
  success_pct: number
  truncated: boolean
  failures: SpellFailure[]
}

function isSpellSuite(j: unknown): j is SpellSuiteJson {
  return typeof j === "object" && j !== null && "missing" in j
}

// --- what the docs site reads -------------------------------------------

export type SuiteKind = "lemma" | "speller"

export type SuiteSummary = {
  id: string
  title: string
  kind: SuiteKind
  lexc: string | null
  lemmas: number | null
  success_pct: number | null
  truncated: boolean
  failures: number
}

export type TestlogsManifest = {
  generated: string
  commit: string | null
  build_url: string | null
  suites: SuiteSummary[]
}

/** A per-suite detail file — the native failure array, unchanged. */
export type SuiteDetail = {
  id: string
  kind: SuiteKind
  failures: LemmaFailure[] | SpellFailure[]
}

/** Filename stem (`nouns-lemmas.json`) → suite id (`nouns`). */
export function suiteIdFromFile(file: string): string {
  return path.basename(file).replace(/-lemmas\.json$/, "").replace(/\.json$/, "")
}

function toSuite(
  id: string,
  json: LemmaSuiteJson | SpellSuiteJson,
): { summary: SuiteSummary; detail: SuiteDetail } {
  const speller = isSpellSuite(json)
  return {
    summary: {
      id,
      title: id,
      kind: speller ? "speller" : "lemma",
      lexc: speller ? null : (json as LemmaSuiteJson).lexc ?? null,
      lemmas: json.lemmas ?? null,
      success_pct: json.success_pct ?? null,
      truncated: Boolean(json.truncated),
      failures: json.failures?.length ?? 0,
    },
    detail: {
      id,
      kind: speller ? "speller" : "lemma",
      failures: json.failures ?? [],
    },
  }
}

/**
 * Read every `*-lemmas.json` in a directory. Returns the manifest suites (sorted)
 * and the per-suite detail for those that have failures.
 */
export async function readTestlogs(dir: string): Promise<{
  summaries: SuiteSummary[]
  details: SuiteDetail[]
}> {
  const parsed: Array<{ summary: SuiteSummary; detail: SuiteDetail }> = []

  if (await fs.exists(dir)) {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith("-lemmas.json")) continue
      const raw = await Deno.readTextFile(path.join(dir, entry.name))
      let json: LemmaSuiteJson | SpellSuiteJson
      try {
        json = JSON.parse(raw)
      } catch {
        continue
      }
      parsed.push(toSuite(suiteIdFromFile(entry.name), json))
    }
  }

  parsed.sort((a, b) => a.summary.id.localeCompare(b.summary.id))

  return {
    summaries: parsed.map((p) => p.summary),
    details: parsed.map((p) => p.detail).filter((d) => d.failures.length > 0),
  }
}
