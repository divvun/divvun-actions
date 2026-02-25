import { runLangTests } from "./common.ts"

export default async function langGrammarTest() {
  await runLangTests({
    metadataKey: "grammar-configure-flags",
    label: "grammar checker",
  })
}
