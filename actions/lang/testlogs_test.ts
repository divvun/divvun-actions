import { assertEquals } from "@std/assert"
import { readTestlogs, suiteIdFromFile } from "./testlogs.ts"

const lemmaSuite = {
  pos: "nouns",
  lexc: "nouns.lexc",
  lemmas: 25002,
  tested: 25002,
  ungenerated: 1,
  mismatched: 0,
  success_pct: 99.99,
  threshold: 100,
  truncated: false,
  failures: [
    {
      lemma: "email",
      no_generation: ["email+N+Pl+Nom", "email+N+Sg+Nom"],
      wrong_generation: [],
      analyses: ["email+N"],
    },
  ],
  settings: {},
}

const spellSuite = {
  lemmas: 137626,
  tested: 137626,
  missing: 2,
  success_pct: 99.99,
  threshold: 100,
  truncated: true,
  failures: [
    { lemma: "kaffe", suggestions: ["kaffe", "kaffi"] },
    { lemma: "te", suggestions: [] },
  ],
  settings: {},
}

async function fixtureDir(
  files: Record<string, unknown>,
): Promise<string> {
  const dir = await Deno.makeTempDir()
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(
      `${dir}/${name}`,
      typeof content === "string" ? content : JSON.stringify(content),
    )
  }
  return dir
}

Deno.test("suiteIdFromFile", () => {
  assertEquals(suiteIdFromFile("nouns-lemmas.json"), "nouns")
  assertEquals(suiteIdFromFile("speller-lemmas.json"), "speller")
})

Deno.test("readTestlogs: lemma + speller suites, sorted", async () => {
  const dir = await fixtureDir({
    "nouns-lemmas.json": lemmaSuite,
    "speller-lemmas.json": spellSuite,
    "adjectives-lemmas.json": { ...lemmaSuite, pos: "adjectives", failures: [] },
    "notes.txt": "ignored",
  })
  const { summaries, details } = await readTestlogs(dir)

  assertEquals(summaries.map((s) => s.id), ["adjectives", "nouns", "speller"])

  const nouns = summaries[1]
  assertEquals(nouns.kind, "lemma")
  assertEquals(nouns.lexc, "nouns.lexc")
  assertEquals(nouns.failures, 1)
  assertEquals(nouns.truncated, false)

  const speller = summaries[2]
  assertEquals(speller.kind, "speller")
  assertEquals(speller.lexc, null)
  assertEquals(speller.failures, 2)
  assertEquals(speller.truncated, true)

  // detail files only for suites with failures
  assertEquals(details.map((d) => d.id), ["nouns", "speller"])
  assertEquals(
    (details[0].failures[0] as { no_generation: string[] }).no_generation,
    ["email+N+Pl+Nom", "email+N+Sg+Nom"],
  )
  assertEquals(
    (details[1].failures[0] as { suggestions: string[] }).suggestions,
    ["kaffe", "kaffi"],
  )

  await Deno.remove(dir, { recursive: true })
})

Deno.test("readTestlogs: missing dir and bad json are tolerated", async () => {
  assertEquals(await readTestlogs("/no/such/dir"), {
    summaries: [],
    details: [],
  })

  const dir = await fixtureDir({ "nouns-lemmas.json": "{ not json" })
  assertEquals((await readTestlogs(dir)).summaries, [])
  await Deno.remove(dir, { recursive: true })
})
