import { deepEqual, equal, ok } from "node:assert/strict"
import type { AgentsObject, CommandStep } from "~/builder/pipeline.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:necessary-nu/frakt.git")
Deno.env.delete("BUILDKITE_PLUGINS")

const builder = await import("~/builder.ts")
const { createCiPipeline } = await import("~/cli.ts")
const { fraktRelease } = await import("~/pipelines/frakt.ts")

async function steps(
  build: { tag?: string; pullRequest?: string } = {},
): Promise<CommandStep[]> {
  builder.env.repoName = "frakt"
  builder.env.repoPath = "necessary-nu/frakt"
  builder.env.branch = "main"
  builder.env.tag = build.tag
  builder.env.pullRequest = build.pullRequest ?? "false"
  return (await createCiPipeline()).steps as CommandStep[]
}

const publishes = (step: CommandStep) =>
  step.command === "divvun-actions run frakt-publish"

Deno.test("frakt is tested on each system with its own backend", async () => {
  const tests = (await steps()).filter((step) => step.key?.startsWith("test-"))
  deepEqual(
    tests.map((step) => [
      (step.agents as AgentsObject | undefined)?.queue,
      step.env?.BACKEND,
    ]),
    [["linux", "reqwest"], ["macos", "foundation"], ["windows", "windows"]],
  )
  ok(String(tests[1].command).includes("--features backend-foundation"))
  ok(String(tests[2].command).includes("--features backend-winhttp"))
})

Deno.test("only a tag v<version> publishes frakt-background, once everything has passed", async () => {
  equal((await steps()).some(publishes), false)
  equal((await steps({ tag: "mobile/v1.0.0" })).some(publishes), false)

  const release = await steps({ tag: "v0.1.0" })
  const publish = release.find(publishes)
  ok(publish)
  deepEqual(
    publish.depends_on,
    release.filter((step) => step !== publish).map((step) => step.key),
  )
})

Deno.test("a pull request tagged like a release does not publish", async () => {
  equal(
    (await steps({ tag: "v0.1.0", pullRequest: "7" })).some(publishes),
    false,
  )
})

Deno.test("a release's version is its tag's without the v", () => {
  equal(fraktRelease("v0.1.0"), "0.1.0")
  equal(fraktRelease("v1.2.3-rc.1"), "1.2.3-rc.1")
  equal(fraktRelease("0.1.0"), null)
  equal(fraktRelease("swift/v0.1.0"), null)
  equal(fraktRelease(undefined), null)
})
