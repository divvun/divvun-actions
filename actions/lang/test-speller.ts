import { runLangTests } from "./common.ts"

export default async function langSpellerTest() {
  await runLangTests({ metadataKey: "speller-configure-flags", label: "speller" })
}
