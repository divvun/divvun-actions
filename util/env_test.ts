import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { BUILD_TIMESTAMP, env } from "~/util/env.ts"

function withEnv(vars: Record<string, string>, run: () => void) {
  for (const [key, value] of Object.entries(vars)) {
    Deno.env.set(key, value)
  }
  try {
    run()
  } finally {
    for (const key of Object.keys(vars)) {
      Deno.env.delete(key)
    }
  }
}

Deno.test("every step of a build stamps the timestamp its pipeline was given", () => {
  withEnv({
    TESTKITE_REPO: "git@github.com:giellalt/lang-sme.git",
    [BUILD_TIMESTAMP]: "2026-11-06T12:34:56.789Z",
  }, () => {
    strictEqual(env("TESTKITE").buildTimestamp, "2026-11-06T12:34:56.789Z")
    strictEqual(env("TESTKITE").buildTimestamp, "2026-11-06T12:34:56.789Z")
  })
})

Deno.test("an agent's tags are read from its environment", () => {
  withEnv({
    TESTKITE_REPO: "git@github.com:giellalt/lang-sme.git",
    TESTKITE_AGENT_META_DATA_QUEUE: "linux",
  }, () => {
    deepStrictEqual(env("TESTKITE").agentMetaData, { queue: "linux" })
  })
})
