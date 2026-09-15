import {
  deepStrictEqual,
  doesNotMatch,
  match,
  rejects,
} from "node:assert/strict"
import * as path from "@std/path"
import { stageSpellerProofing } from "./speller.ts"

Deno.test("spelling stage excludes grammar assets and retains the proofing output pipeline", async () => {
  const root = await Deno.makeTempDir({ prefix: "proofing-test-" })
  try {
    const build = path.join(root, "build")
    const stage = path.join(root, "stage")
    await Deno.mkdir(stage)
    const files = [
      "tools/tokenisers/tokeniser-gramcheck-gt-desc.pmhfst",
      "tools/tokenisers/mwe-dis.bin",
      "tools/grammarcheckers/acceptor.default.hfst",
      "tools/grammarcheckers/errmodel.default.hfst",
      "tools/grammarcheckers/analyser-gt-whitespace.hfst",
      "src/fst/generator-gramcheck-gt-norm.hfstol",
      // A reused workspace may contain these. They must never enter the DRB.
      "tools/grammarcheckers/grammarchecker.bin",
      "tools/grammarcheckers/disambiguator.bin",
      "tools/grammarcheckers/assets/old-model.hfst",
    ]
    for (const name of files) {
      const target = path.join(build, name)
      await Deno.mkdir(path.dirname(target), { recursive: true })
      await Deno.writeTextFile(target, name)
    }
    await stageSpellerProofing(build, stage)
    const staged = []
    for await (const file of Deno.readDir(path.join(stage, "assets"))) {
      staged.push(file.name)
    }
    deepStrictEqual(
      staged.sort(),
      [
        "acceptor.default.hfst",
        "analyser-gt-whitespace.hfst",
        "errmodel.default.hfst",
        "errors-en.ftl",
        "errors.json",
        "generator-gramcheck-gt-norm.hfstol",
        "mwe-dis.bin",
        "spelling.cg3",
        "tokeniser-gramcheck-gt-desc.pmhfst",
      ].sort(),
    )
    const pipeline = await Deno.readTextFile(path.join(stage, "pipeline.ts"))
    match(pipeline, /divvun.cgspell/)
    match(pipeline, /return divvun.suggest/)
    doesNotMatch(pipeline, /grammarchecker.bin|disambiguator.bin/)
    deepStrictEqual(
      JSON.parse(
        await Deno.readTextFile(path.join(stage, "assets/errors.json")),
      ),
      {
        "spelling-error": [{ id: "typo" }],
      },
    )
    // Reusing a dirty stage or silently omitting a required model must fail.
    await rejects(
      () => stageSpellerProofing(build, stage),
      Deno.errors.AlreadyExists,
    )
    await Deno.remove(path.join(build, files[0]))
    const missing = path.join(root, "missing")
    await Deno.mkdir(missing)
    await rejects(
      () => stageSpellerProofing(build, missing),
      Deno.errors.NotFound,
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
