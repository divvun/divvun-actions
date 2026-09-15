import { deepStrictEqual, strictEqual } from "node:assert/strict"
import { proofingArtifact, proofingPackage, proofingSource } from "./source.ts"

Deno.test("proofing source follows enabled features, not manifest stanzas", () => {
  strictEqual(
    proofingSource({ spellers: true, "grammar-checkers": false }),
    "speller",
  )
  strictEqual(
    proofingSource({ spellers: true, "grammar-checkers": true }),
    "grammar",
  )
  strictEqual(
    proofingSource({ spellers: false, "grammar-checkers": true }),
    "grammar",
  )
  strictEqual(
    proofingSource({ spellers: false, "grammar-checkers": false }),
    undefined,
  )
  strictEqual(proofingSource(), undefined)
  const manifest = {
    package: {
      speller: { name: "Kildin Sami", version: "0.1.1" },
      grammar: { name: "Unused grammar", version: "0.1.0" },
    },
  }
  deepStrictEqual(
    proofingPackage("speller", manifest),
    manifest.package.speller,
  )
  deepStrictEqual(
    proofingPackage("grammar", manifest),
    manifest.package.grammar,
  )
  strictEqual(proofingArtifact("speller"), "build/tools/proofing/bundle.drb")
  strictEqual(proofingArtifact("grammar"), "build/tools/grammarcheckers/*.drb")
  deepStrictEqual(
    proofingPackage("grammar", {
      package: { speller: manifest.package.speller },
    }, "sjd"),
    { name: "sjd", version: "0.1.1" },
  )
})
