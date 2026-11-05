import { equal, ok, rejects } from "node:assert/strict"
import type { Step } from "~/builder/pipeline.ts"
import { commandRequiresTrustedContext } from "~/util/privileged_action.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/box.git")
Deno.env.delete("BUILDKITE_PLUGINS")

const builder = await import("~/builder.ts")
const { createCiPipeline, default: runCli } = await import("~/cli.ts")

function commands(steps: Step[]): string[] {
  return steps.flatMap((step) => {
    if ("group" in step) return commands(step.steps)
    if (!("command" in step) || step.command == null) return []
    return typeof step.command === "string" ? [step.command] : step.command
  })
}

Deno.test("main pull requests never generate sign, publish, or deploy commands", async () => {
  builder.env.repoName = "box"
  builder.env.repoPath = "divvun/box"
  builder.env.branch = "main"
  builder.env.tag = undefined
  builder.env.pullRequest = "42"

  const pipeline = await createCiPipeline()
  const generated = commands(pipeline.steps)
  ok(generated.some((command) => command.includes("cargo build")))
  equal(generated.some(commandRequiresTrustedContext), false)
  equal(generated.some((command) => /(?:publish|deploy)/.test(command)), false)
})

Deno.test("trusted release builds retain signing and publication", async () => {
  builder.env.repoName = "box"
  builder.env.repoPath = "divvun/box"
  builder.env.branch = "main"
  builder.env.tag = "v1.2.3"
  builder.env.pullRequest = "false"

  const generated = commands((await createCiPipeline()).steps)
  ok(generated.some((command) => command.includes("divvun-actions sign")))
  ok(generated.some((command) => command.includes("box-publish")))
})

Deno.test("mobile pull requests skip credential-dependent packaging", async () => {
  builder.env.repoName = "divvun-keyboard"
  builder.env.repoPath = "divvun/divvun-keyboard"
  builder.env.branch = "main"
  builder.env.tag = undefined
  builder.env.pullRequest = "42"

  const generated = commands((await createCiPipeline()).steps)
  equal(generated.length, 1)
  ok(generated[0].includes("No secret-free build or test steps"))
  equal(generated.some(commandRequiresTrustedContext), false)
})

Deno.test("pull requests cannot fetch secrets or invoke privileged commands directly", async () => {
  builder.env.repoName = "box"
  builder.env.repoPath = "divvun/box"
  builder.env.branch = "main"
  builder.env.tag = undefined
  builder.env.pullRequest = "42"

  await rejects(
    builder.secrets("github/token"),
    /Refusing to access CI secrets/,
  )
  await rejects(
    runCli(["sign", "artifact.exe"]),
    /Refusing to sign an artifact/,
  )
  await rejects(
    runCli(["run", "box-publish"]),
    /Refusing to run 'box-publish'/,
  )
})
