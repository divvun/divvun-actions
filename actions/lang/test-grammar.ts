import { runLangTests } from "./common.ts"

export default async function langGrammarTest() {
  await runLangTests({
    // grammar-build's own tree, so this tests the grammar checker it shipped
    // rather than rebuilding it from the speller tree.
    snapshot: "grammar",
    metadataKey: "grammar-configure-flags",
    label: "grammar checker",
  })
}
