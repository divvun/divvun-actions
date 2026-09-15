import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict"
import { type CommandStep, validatePipeline } from "~/builder/pipeline.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:necessary-nu/msgrammar.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const builder = await import("~/builder.ts")
const { createCiPipeline } = await import("~/cli.ts")
const target = await import("~/target.ts")

Deno.test("msgrammar checks and builds Windows x64 on branches, PRs and tags without publishing", async () => {
  for (
    const [branch, tag, pullRequest] of [
      ["main", undefined, "false"],
      ["feature", undefined, "false"],
      ["feature", undefined, "42"],
      ["main", "v0.1.0", "false"],
    ] as const
  ) {
    builder.env.branch = branch
    builder.env.tag = tag
    builder.env.pullRequest = pullRequest
    const pipeline = await createCiPipeline()
    validatePipeline(pipeline)
    strictEqual(pipeline.steps.length, 1)
    const step = pipeline.steps[0] as CommandStep
    strictEqual(step.key, "check-build-x86_64-pc-windows-msvc")
    strictEqual(step.command, "pwsh -NoProfile -File scripts/buildkite.ps1")
    deepStrictEqual(step.agents, { queue: "windows" })
    deepStrictEqual(step.plugins, [
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ])
    strictEqual(step.timeout_in_minutes, 45)
    ok(!step.soft_fail)
    ok(!step.allow_dependency_failure)
    ok(!step.skip)
  }
})

Deno.test("msgrammar registration keeps unknown repositories rejected", async () => {
  builder.env.repoName = "unrecognized-msgrammar-repo"
  try {
    await rejects(
      createCiPipeline(),
      /Unknown repo: unrecognized-msgrammar-repo/,
    )
  } finally {
    builder.env.repoName = "msgrammar"
  }
})
