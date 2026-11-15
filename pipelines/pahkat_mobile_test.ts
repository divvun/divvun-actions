import { deepEqual, equal, throws } from "node:assert/strict"
import type { AgentsObject, CommandStep, Step } from "~/builder/pipeline.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/pahkat-next.git")
Deno.env.delete("BUILDKITE_PLUGINS")

const builder = await import("~/builder.ts")
const { createCiPipeline } = await import("~/cli.ts")
const { checkMobileVersion, mobileRelease } = await import(
  "~/pipelines/pahkat-mobile.ts"
)

async function steps(
  build: { branch?: string; tag?: string; pullRequest?: string },
): Promise<CommandStep[]> {
  builder.env.repoName = "pahkat-next"
  builder.env.repoPath = "divvun/pahkat-next"
  builder.env.branch = build.branch ?? build.tag ?? "main"
  builder.env.tag = build.tag
  builder.env.pullRequest = build.pullRequest ?? "false"
  return (await createCiPipeline()).steps.filter((step: Step) =>
    "command" in step
  ) as CommandStep[]
}

const mobile = (step: CommandStep) =>
  [step.command].flat().some((command) =>
    command?.includes("divvun-actions run pahkat-mobile-")
  )

Deno.test("a tag mobile/v<version> builds on macOS and publishes from Linux", async () => {
  const release = (await steps({ tag: "mobile/v3.0.0-alpha.1" })).filter(
    mobile,
  )
  deepEqual(
    release.map((step) => [
      (step.agents as AgentsObject).queue,
      [step.command].flat().at(-1),
      step.depends_on,
    ]),
    [
      [
        "macos",
        "divvun-actions run pahkat-mobile-swift-archive",
        undefined,
      ],
      [
        "linux",
        "divvun-actions run pahkat-mobile-swift-publish",
        release[0].key,
      ],
      ["linux", "divvun-actions run pahkat-mobile-maven-publish", undefined],
    ],
  )
})

Deno.test("no other build publishes the mobile client", async () => {
  equal((await steps({})).some(mobile), false)
  equal((await steps({ tag: "v3.0.0" })).some(mobile), false)
  const pullRequest = await steps({
    tag: "mobile/v3.0.0-alpha.1",
    pullRequest: "7",
  })
  equal(
    pullRequest.some((step) =>
      [step.command].flat().some((command) => command?.includes("-publish"))
    ),
    false,
  )
})

Deno.test("a mobile release's version is its tag's", () => {
  equal(mobileRelease("mobile/v3.0.0-alpha.1"), "3.0.0-alpha.1")
  equal(mobileRelease("mobile/v3.0.0"), "3.0.0")
  equal(mobileRelease("v3.0.0"), null)
  equal(mobileRelease("swift/v3.0.0"), null)
  equal(mobileRelease(undefined), null)
})

Deno.test("only the workspace's version, or a prerelease of it, is published", () => {
  checkMobileVersion("3.0.0-alpha.1", "3.0.0")
  checkMobileVersion("3.0.0", "3.0.0")
  checkMobileVersion("3.0.0-rc.2+build.5", "3.0.0")
  for (const version of ["3.0.1-alpha.1", "2.9.0", "3.0.0.1", "30.0.0"]) {
    throws(
      () => checkMobileVersion(version, "3.0.0"),
      /the workspace's version is 3\.0\.0/,
      version,
    )
  }
})
