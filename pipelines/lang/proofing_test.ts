import { makeTempDir } from "~/util/temp.ts"
import { ok, strictEqual } from "node:assert/strict"
import type { CommandStep } from "~/builder/pipeline.ts"

// Only pipeline generation runs here. Tests have no network or subprocess
// permission, so artifact upload, signing, and deployment cannot execute.
Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:giellalt/lang-sjd.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const builder = await import("~/builder.ts")
const { pipelineLang } = await import("./mod.ts")

Deno.test("proofing DAG: grammar, spelling, disabled, main, PR and release tags", async () => {
  const cwd = Deno.cwd()
  const root = (await makeTempDir({ prefix: "proofing-dag-" })).path
  try {
    Deno.chdir(root)
    for (const source of ["speller", "grammar", "disabled"] as const) {
      await Deno.writeTextFile(
        ".build-config.yml",
        `build:
  spellers: ${source !== "disabled"}
  grammar-checkers: ${source === "grammar"}
`,
      )
      for (
        const [branch, tag, publish] of [
          ["main", undefined, true],
          ["feature", undefined, false],
          ["main", "x-proofing-sjd/v0.1.1", true],
          ["release", "x-proofing-sjd/v0.1.1", true],
          ["main", "speller-sjd/v0.1.1", false],
          ["main", "grammar-sjd/v0.1.0", false],
          ["main", "tts-textproc-sjd/v0.1.0", false],
          ["main", "teaksta-sjd/v0.1.0", false],
          ["release", "teaksta-sjd/v0.1.0", false],
          ["release", "speller-sjd/v0.1.1", false],
          ["release", "grammar-sjd/v0.1.0", false],
          ["release", "tts-textproc-sjd/v0.1.0", false],
        ] as const
      ) {
        builder.env.branch = branch
        builder.env.tag = tag
        const pipeline = await pipelineLang()
        const steps = pipeline.steps.flatMap((step) =>
          typeof step === "object" && "group" in step ? step.steps : [step]
        ) as CommandStep[]
        const enabled = publish && source !== "disabled"
        const proofing = steps.filter((step) =>
          step.key?.startsWith("proofing-bundle-")
        )
        strictEqual(
          proofing.length,
          enabled ? 3 : 0,
          `${source} ${branch} ${tag}`,
        )
        strictEqual(
          steps.some((step) => step.key === "proofing-build"),
          enabled && source === "speller",
        )
        if (source !== "grammar") {
          ok(!steps.some((step) => step.key === "grammar-build"))
        }
        for (const step of proofing) {
          strictEqual(
            step.depends_on,
            source === "grammar" ? "grammar-build" : "proofing-build",
          )
          ok(steps.some((producer) => producer.key === step.depends_on))
        }
        const deploy = steps.filter((step) =>
          step.command === "divvun-actions run lang-proofing-deploy"
        )
        strictEqual(deploy.length, enabled ? 1 : 0)
      }
    }
  } finally {
    Deno.chdir(cwd)
    await Deno.remove(root, { recursive: true })
  }
})
