import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { validatePipeline } from "~/builder/pipeline.ts"
import type { CommandStep } from "~/builder/pipeline.ts"

// Exercise the same repository dispatch used by `divvun-actions ci`, without
// granting subprocess/network permissions or uploading anything to Buildkite.
Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/divvun-wind.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const builder = await import("~/builder.ts")
const { createCiPipeline } = await import("~/cli.ts")
const target = await import("~/target.ts")

Deno.test("Wind CI dispatch selects the managed Windows build for branches and tags", async () => {
  for (
    const [branch, tag] of [
      ["main", undefined],
      ["ci-fix", undefined],
      ["main", "v0.1.0"],
    ]
  ) {
    builder.env.branch = branch
    builder.env.tag = tag
    const pipeline = await createCiPipeline()
    validatePipeline(pipeline)
    strictEqual(pipeline.steps.length, 1)
    const step = pipeline.steps[0] as CommandStep
    strictEqual(step.key, "check-build-x86_64-pc-windows-msvc")
    deepStrictEqual(step.agents, { queue: "windows" })
    deepStrictEqual(step.plugins, [
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ])
    const commands = step.command as string[]
    ok(commands[0].includes("msvc-env x64"))
    ok(commands[0].includes("./scripts/ci.ps1 -Build"))
    ok(commands[0].includes("$$ErrorActionPreference = 'Stop'"))
    ok(
      commands[0].endsWith("if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }"),
    )
    deepStrictEqual(commands.slice(1), [
      "buildkite-agent artifact upload target/x86_64-pc-windows-msvc/release/divvun-wind.exe; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }",
      "buildkite-agent artifact upload target/x86_64-pc-windows-msvc/release/divvun-wind-symbols.exe; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }",
      "buildkite-agent artifact upload target/x86_64-pc-windows-msvc/release/divvun_keyboard_labels.dll; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }",
      "buildkite-agent artifact upload 'target/x86_64-pc-windows-msvc/release/*.pdb'; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }",
    ])
  }
})

Deno.test("CI dispatch still rejects unrecognized repository names", async () => {
  builder.env.repoName = "unrecognized-wind-repo"
  try {
    await createCiPipeline()
    throw new Error("expected unknown repository failure")
  } catch (error) {
    ok(error instanceof Error)
    strictEqual(error.message, "Unknown repo: unrecognized-wind-repo")
  } finally {
    builder.env.repoName = "divvun-wind"
  }
})
