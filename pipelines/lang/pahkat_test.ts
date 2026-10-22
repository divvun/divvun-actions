import { strictEqual } from "node:assert/strict"
import type { BuildProps } from "./mod.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:giellalt/lang-sjd.git")
Deno.env.delete("BUILDKITE_PLUGINS")
const { pahkatSkipReason } = await import("./mod.ts")

const spellers = (on: boolean) => ({ spellers: on }) as BuildProps

Deno.test("pahkatSkipReason publishes public repos with spellers enabled", () => {
  strictEqual(pahkatSkipReason("lang-sme", spellers(true), false), null)
  strictEqual(
    pahkatSkipReason("lang-nno-x-ext-apertium", spellers(true), false),
    null,
  )
})

Deno.test("pahkatSkipReason skips repos without spellers enabled", () => {
  const reason = "build.spellers is not true in .build-config.yml"
  strictEqual(pahkatSkipReason("lang-sjd", spellers(false), false), reason)
  strictEqual(
    pahkatSkipReason("lang-est-x-plamk", spellers(false), false),
    reason,
  )
  strictEqual(pahkatSkipReason("lang-zxx", undefined, false), reason)
})

Deno.test("pahkatSkipReason skips private and sensitive repos", () => {
  strictEqual(
    pahkatSkipReason("lang-sjd-x-private", spellers(true), false),
    "repo name ends in -x-private",
  )
  strictEqual(
    pahkatSkipReason("lang-foo-x-sensitive", spellers(true), false),
    "repo name ends in -x-sensitive",
  )
  strictEqual(
    pahkatSkipReason("lang-isl", spellers(true), true),
    "repo is private",
  )
})
