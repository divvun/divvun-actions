import { equal, throws } from "node:assert/strict"
import { SecretsStore } from "~/util/openbao.ts"

Deno.test("secret views expose only explicitly requested keys", () => {
  const all = new SecretsStore({ signing: "one", publishing: "two" })
  const signing = all.only(["signing"])

  equal(signing.get("signing"), "one")
  throws(() => signing.get("publishing"), /not found/)
})
