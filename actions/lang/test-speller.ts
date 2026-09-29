import { runLangTests } from "./common.ts"

export default async function langSpellerTest() {
  await runLangTests({
    snapshot: "speller",
    metadataKey: "speller-configure-flags",
    label: "speller",
  })
}
