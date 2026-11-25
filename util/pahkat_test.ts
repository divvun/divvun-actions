import { equal, rejects } from "node:assert/strict"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/pahkat-next.git")
Deno.env.set("BUILDKITE_BRANCH", "main")
Deno.env.delete("BUILDKITE_PLUGINS")

const { waitUntilServing } = await import("~/util/pahkat.ts")
const { pipelinePahkatServer } = await import("~/pipelines/pahkat-server.ts")

const COMMIT = "9325eeee505eefeb7bf74650388070a828b78a79"
const OLDER = "2efd68b517c9ff65d55d1b0dde4bab435c581633"

/**
 * A server answering `/version` with each of `commits` in turn, then the
 * last for good, on a clock that moves only as the wait sleeps.
 */
function serving(commits: (string | Error)[]) {
  let time = 0
  const asked: string[] = []
  const slept: number[] = []
  const clock = {
    fetch: (input: URL | Request | string) => {
      asked.push(`${input}`)
      const next = commits.length > 1 ? commits.shift()! : commits[0]
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(Response.json({ version: "3.0.0", commit: next }))
    },
    sleep: (ms: number) => {
      slept.push(ms)
      time += ms
      return Promise.resolve()
    },
    now: () => time,
  }
  return { clock, asked, slept }
}

Deno.test("the CLI waits until ten answers in a row name its build", async () => {
  const answers = [
    OLDER,
    COMMIT,
    new Error("refused"),
    ...Array(12).fill(COMMIT),
  ]
  const { clock, asked, slept } = serving(answers)
  await waitUntilServing(COMMIT, "https://pahkat.test/", clock)
  equal(asked[0], "https://pahkat.test/version")
  equal(asked.length, 13)
  equal(slept.filter((ms) => ms > 0).length, 2)
})

Deno.test("the CLI gives up on a server that never serves its build", async () => {
  const { clock } = serving([OLDER])
  await rejects(
    waitUntilServing(COMMIT, "https://pahkat.test/", clock),
    new RegExp(
      `did not serve ${COMMIT} within 15 minutes; it last answered commit ${OLDER}`,
    ),
  )
})

Deno.test("the CLI is published only after the server's image is pinned", () => {
  const steps = pipelinePahkatServer().steps as {
    key?: string
    label?: string
    depends_on?: string | string[]
  }[]
  const bump = steps.find((step) => step.label === "Bump k8s app manifest")
  const publish = steps.find((step) => step.label === "Publish CLI to Pahkat")
  equal(bump?.key != null, true)
  equal((publish?.depends_on as string[]).includes(bump!.key!), true)
})
