import { deepEqual, equal, rejects, throws } from "node:assert/strict"
import type { BuildkitePipeline } from "~/services/sync-github/types.ts"
import * as path from "@std/path"
import {
  API_TOKEN_VARIABLE,
  apiToken,
  buildRequests,
  matchingPipelines,
  runTrigger,
  type TriggerOptions,
} from "./mod.ts"

const API = "https://api.buildkite.com/v2/organizations/divvun"

function apiPipeline(
  slug: string,
  { defaultBranch = "main", archived = false } = {},
) {
  return {
    id: slug,
    name: slug,
    slug,
    web_url: `https://buildkite.com/divvun/${slug}`,
    provider: { webhook_url: "" },
    repository: `git@github.com:giellalt/${slug}.git`,
    default_branch: defaultBranch,
    archived_at: archived ? "2026-01-01T00:00:00Z" : null,
  }
}

const PIPELINES = [
  apiPipeline("lang-sme"),
  apiPipeline("lang-smj", { defaultBranch: "develop" }),
  apiPipeline("lang-old", { archived: true }),
  apiPipeline("keyboard-sme"),
]

type Request = { method: string; url: string; body?: unknown; auth?: string }

/**
 * Answers the Buildkite API from PIPELINES, numbering each build it is asked
 * for, and fails the POSTs `failing` names with a 502.
 */
function stubBuildkite(failing: string[] = []) {
  const requests: Request[] = []
  const realFetch = globalThis.fetch
  let builds = 0
  globalThis.fetch = (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    requests.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("Authorization") ?? undefined,
    })
    if (method === "GET" && url.startsWith(`${API}/pipelines?`)) {
      return Promise.resolve(Response.json(PIPELINES))
    }
    const build = url.match(/\/pipelines\/([^/]+)\/builds$/)
    if (method === "POST" && build) {
      if (failing.includes(build[1])) {
        return Promise.resolve(new Response("bad gateway", { status: 502 }))
      }
      builds += 1
      return Promise.resolve(Response.json({
        number: builds,
        web_url: `https://buildkite.com/divvun/${build[1]}/builds/${builds}`,
      }))
    }
    return Promise.resolve(new Response("not found", { status: 404 }))
  }
  return {
    requests,
    posts: () => requests.filter((request) => request.method === "POST"),
    [Symbol.dispose]: () => {
      globalThis.fetch = realFetch
    },
  }
}

function options(overrides: Partial<TriggerOptions> = {}): TriggerOptions {
  return {
    pattern: /^lang-/,
    org: "divvun",
    message: "Rebuild",
    dryRun: false,
    yes: true,
    ...overrides,
  }
}

function pipelines(...slugs: string[]): BuildkitePipeline[] {
  return slugs.map((slug) =>
    ({
      slug,
      default_branch: slug === "lang-smj" ? "develop" : "main",
      archived_at: slug === "lang-old" ? "2026-01-01T00:00:00Z" : null,
    }) as BuildkitePipeline
  )
}

Deno.test("only unarchived pipelines whose slug matches are built", () => {
  const all = pipelines("lang-sme", "lang-old", "keyboard-sme", "xlang-sme")
  deepEqual(
    matchingPipelines(all, /^lang-/).map((pipeline) => pipeline.slug),
    ["lang-sme"],
  )
  deepEqual(
    matchingPipelines(all, /sme/g).map((pipeline) => pipeline.slug),
    ["lang-sme", "keyboard-sme", "xlang-sme"],
  )
})

Deno.test("each pipeline builds its default branch unless one is given", () => {
  const two = pipelines("lang-sme", "lang-smj")
  deepEqual(buildRequests(two), [
    { pipeline: "lang-sme", branch: "main" },
    { pipeline: "lang-smj", branch: "develop" },
  ])
  deepEqual(buildRequests(two, "release").map((r) => r.branch), [
    "release",
    "release",
  ])
  throws(
    () => buildRequests([{ slug: "x", default_branch: "" } as never]),
    /x has no default branch: pass --branch/,
  )
})

Deno.test("without a token, nothing is asked of Buildkite", async () => {
  using buildkite = stubBuildkite()
  await rejects(runTrigger(options(), ""), /Set BUILDKITE_API_TOKEN/)
  equal(buildkite.requests.length, 0)
})

Deno.test("a dry run lists the builds and triggers none", async () => {
  using buildkite = stubBuildkite()
  deepEqual(await runTrigger(options({ dryRun: true }), "token"), [])
  equal(buildkite.posts().length, 0)
})

Deno.test("declining the prompt triggers nothing", async () => {
  using buildkite = stubBuildkite()
  const realConfirm = globalThis.confirm
  globalThis.confirm = () => false
  try {
    deepEqual(await runTrigger(options({ yes: false }), "token"), [])
  } finally {
    globalThis.confirm = realConfirm
  }
  equal(buildkite.posts().length, 0)
})

Deno.test("each match is built at the head of its branch", async () => {
  using buildkite = stubBuildkite()
  const builds = await runTrigger(options(), "token")
  deepEqual(builds.map(({ pipeline, number }) => [pipeline, number]), [
    ["lang-sme", 1],
    ["lang-smj", 2],
  ])
  deepEqual(buildkite.posts(), [
    {
      method: "POST",
      url: `${API}/pipelines/lang-sme/builds`,
      body: { commit: "HEAD", branch: "main", message: "Rebuild" },
      auth: "Bearer token",
    },
    {
      method: "POST",
      url: `${API}/pipelines/lang-smj/builds`,
      body: { commit: "HEAD", branch: "develop", message: "Rebuild" },
      auth: "Bearer token",
    },
  ])
})

Deno.test("a build that fails to start is not retried, and the rest still are", async () => {
  using buildkite = stubBuildkite(["lang-sme"])
  await rejects(
    runTrigger(options(), "token"),
    /Triggered 1 of 2 builds; these failed: lang-sme/,
  )
  deepEqual(buildkite.posts().map((post) => post.url), [
    `${API}/pipelines/lang-sme/builds`,
    `${API}/pipelines/lang-smj/builds`,
  ])
})

/**
 * Runs `f` with BUILDKITE_API_TOKEN set to `variable` or unset, in a home of
 * its own whose ~/.buildkite-token holds `file`, if it is given.
 */
async function withTokenSources(
  { variable, file }: { variable?: string; file?: string },
  f: (home: string) => Promise<void>,
) {
  const before = Deno.env.get(API_TOKEN_VARIABLE)
  const home = await Deno.makeTempDir()
  try {
    if (variable == null) Deno.env.delete(API_TOKEN_VARIABLE)
    else Deno.env.set(API_TOKEN_VARIABLE, variable)
    if (file != null) {
      await Deno.writeTextFile(path.join(home, ".buildkite-token"), file)
    }
    await f(home)
  } finally {
    if (before == null) Deno.env.delete(API_TOKEN_VARIABLE)
    else Deno.env.set(API_TOKEN_VARIABLE, before)
    await Deno.remove(home, { recursive: true })
  }
}

Deno.test("BUILDKITE_API_TOKEN wins over ~/.buildkite-token", async () => {
  await withTokenSources(
    { variable: " from-variable\n", file: "from-file" },
    async (home) => equal(await apiToken(home), "from-variable"),
  )
})

Deno.test("without BUILDKITE_API_TOKEN, ~/.buildkite-token is read", async () => {
  await withTokenSources(
    { file: "from-file\n" },
    async (home) => equal(await apiToken(home), "from-file"),
  )
  await withTokenSources(
    { variable: "", file: "from-file" },
    async (home) => equal(await apiToken(home), "from-file"),
  )
})

Deno.test("an empty or missing ~/.buildkite-token is no token", async () => {
  await withTokenSources(
    {},
    async (home) => equal(await apiToken(home), undefined),
  )
  await withTokenSources(
    { file: " \n" },
    async (home) => equal(await apiToken(home), undefined),
  )
})
