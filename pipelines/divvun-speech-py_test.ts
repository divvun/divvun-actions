import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { CommandStep, validatePipeline } from "~/builder/pipeline.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set(
  "BUILDKITE_REPO",
  "git@github.com:divvun/divvun-speech-py.git",
)

const { pipelineDivvunSpeechPy } = await import(
  "~/pipelines/divvun-speech-py.ts"
)

Deno.test("divvun-speech-py checks the lock and conditionally exports the model", () => {
  const pipeline = pipelineDivvunSpeechPy()
  validatePipeline(pipeline)
  strictEqual(pipeline.steps.length, 2)

  const check = pipeline.steps[0] as CommandStep
  strictEqual(check.key, "python-package")
  deepStrictEqual(check.agents, { queue: "linux" })
  deepStrictEqual(check.command, [
    "uv lock --check",
    "uv build --wheel",
    "buildkite-agent artifact upload 'dist/*.whl'",
  ])

  const exportModel = pipeline.steps[1] as CommandStep
  strictEqual(exportModel.key, "export-multi-sami")
  strictEqual(exportModel.depends_on, "python-package")
  deepStrictEqual(exportModel.agents, { queue: "linux", size: "large" })
  strictEqual(
    exportModel.if,
    'build.env("DIVVUN_SPEECH_CHECKPOINT_URL") != null',
  )
  strictEqual(
    exportModel.command,
    "divvun-actions run divvun-speech-py-export",
  )
})
