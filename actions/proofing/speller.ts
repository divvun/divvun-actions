import * as path from "@std/path"

// Explicit make targets are available with --disable-grammarchecker. These
// models share the historical gramcheck names because cgspell/suggest need
// their CG tags. No grammarchecker.bin, disambiguator, or grammar bundle is built.
export const spellerProofingMakeSteps = [
  [
    "src/fst",
    "analyser-gramcheck-gt-desc.hfst",
    "generator-gramcheck-gt-norm.hfstol",
    "analyser-url-gt-desc.hfst",
    "analyser-emojis-gt-desc.hfst",
  ],
  [
    "tools/tokenisers/filters",
    "make-gramcheck-CG-tags.hfst",
    "gramcheck-tokeniser-flags.hfst",
    "make-url-CG-tags.hfst",
    "make-emojis-CG-tags.hfst",
  ],
  ["tools/tokenisers", "tokeniser-gramcheck-gt-desc.pmhfst", "mwe-dis.bin"],
  ["tools/spellcheckers", "analyser-desktopspeller-gt-norm.hfst"],
  ["tools/grammarcheckers/filters", "make-desktopspeller-CG-tags.hfst"],
  [
    "tools/grammarcheckers",
    "acceptor.default.hfst",
    "errmodel.default.hfst",
    "analyser-gt-whitespace.hfst",
  ],
] as const

const assets = [
  ["tools/tokenisers", "tokeniser-gramcheck-gt-desc.pmhfst"],
  ["tools/tokenisers", "mwe-dis.bin"],
  ["tools/grammarcheckers", "acceptor.default.hfst"],
  ["tools/grammarcheckers", "errmodel.default.hfst"],
  ["tools/grammarcheckers", "analyser-gt-whitespace.hfst"],
  ["src/fst", "generator-gramcheck-gt-norm.hfstol"],
] as const

/** Stage only the assets referenced by the spelling pipeline. */
export async function stageSpellerProofing(buildDir: string, stage: string) {
  // The caller supplies a fresh staging directory, so old grammar assets cannot
  // accidentally be embedded by divvun-runtime's recursive assets collection.
  const assetDir = path.join(stage, "assets")
  await Deno.mkdir(assetDir)
  for (const [directory, name] of assets) {
    await Deno.copyFile(
      path.join(buildDir, directory, name),
      path.join(assetDir, name),
    )
  }
  await Deno.copyFile(
    new URL("./speller-pipeline.ts.in", import.meta.url),
    path.join(stage, "pipeline.ts"),
  )
  await Deno.copyFile(
    new URL("./spelling.cg3", import.meta.url),
    path.join(assetDir, "spelling.cg3"),
  )
  await Deno.writeTextFile(
    path.join(assetDir, "errors.json"),
    JSON.stringify({
      "spelling-error": [{ id: "typo" }],
    }),
  )
  await Deno.writeTextFile(
    path.join(assetDir, "errors-en.ftl"),
    "spelling-error = Spelling error\n    .desc = Check the spelling of this word.\n",
  )
}
