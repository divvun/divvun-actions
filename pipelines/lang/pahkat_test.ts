import { strictEqual } from "node:assert/strict"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:giellalt/lang-sjd.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const { isPahkatPublishable } = await import("./mod.ts")

Deno.test("isPahkatPublishable skips private and testing repos", () => {
  strictEqual(isPahkatPublishable("lang-sjd"), true)
  strictEqual(isPahkatPublishable("lang-nno-x-ext-apertium"), true)
  strictEqual(isPahkatPublishable("lang-est-x-plamk"), true)
  strictEqual(isPahkatPublishable("lang-sjd-x-private"), false)
  strictEqual(isPahkatPublishable("lang-rmu-x-testing"), false)
})
