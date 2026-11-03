import { makeTempDir } from "~/util/temp.ts"
import { ok, strictEqual } from "node:assert/strict"
import type { CommandStep } from "~/builder/pipeline.ts"

// Only pipeline generation runs here; see proofing_test.ts.
Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:giellalt/lang-gag.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const builder = await import("~/builder.ts")
const { pipelineLang } = await import("./mod.ts")

Deno.test("analyser release: built and deployed apart from the speller", async () => {
  const cwd = Deno.cwd()
  const root = (await makeTempDir({ prefix: "analyser-dag-" })).path
  try {
    Deno.chdir(root)
    for (const analysers of [true, false]) {
      for (const spellers of [true, false]) {
        await Deno.writeTextFile(
          ".build-config.yml",
          `build:
  analysers: ${analysers}
  spellers: ${spellers}
  grammar-checkers: true
  tts-textproc: true
`,
        )
        for (
          const [branch, tag, publish] of [
            ["main", undefined, true],
            ["feature", undefined, false],
            ["main", "analyser-gag/v0.1.0", true],
            ["release", "analyser-gag/v0.1.0-beta.1", true],
            ["main", "speller-gag/v0.1.0", false],
            ["main", "grammar-gag/v0.1.0", false],
            ["main", "tts-textproc-gag/v0.1.0", false],
            ["main", "x-proofing-gag/v0.1.0", false],
          ] as const
        ) {
          builder.env.branch = branch
          builder.env.tag = tag
          const context = `analysers=${analysers} spellers=${spellers} ` +
            `${branch} ${tag}`
          const steps = (await pipelineLang()).steps.flatMap((step) =>
            typeof step === "object" && "group" in step ? step.steps : [step]
          ) as CommandStep[]
          const enabled = analysers && publish

          const build = steps.filter((step) => step.key === "analyser-build")
          strictEqual(build.length, enabled ? 1 : 0, context)
          for (const step of build) {
            strictEqual(step.depends_on, "lang-deps", context)
          }

          const deploy = steps.filter((step) =>
            step.command === "divvun-actions run lang-analyser-deploy"
          )
          strictEqual(deploy.length, enabled ? 1 : 0, context)
          for (const step of deploy) {
            // Never waits on the speller installers.
            strictEqual(step.depends_on, "analyser-build", context)
          }

          if (tag?.startsWith("analyser-")) {
            // An analyser tag builds the analysers and nothing else.
            const keys = steps.map((step) => step.key).filter(Boolean)
            strictEqual(
              keys.join(","),
              analysers ? "lang-deps,analyser-build" : "",
              context,
            )
          }
          ok(
            !steps.some((step) =>
              step.command === "divvun-actions run lang-deploy" &&
              JSON.stringify(step.depends_on).includes("analyser")
            ),
            context,
          )
        }
      }
    }
  } finally {
    Deno.chdir(cwd)
    await Deno.remove(root, { recursive: true })
  }
})
