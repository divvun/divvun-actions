import { equal, match } from "node:assert/strict"

const MAIN = new URL("./main.ts", import.meta.url).pathname

/** Runs main.ts as it runs outside a Buildkite job. */
async function divvunActions(...args: string[]) {
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-q", "-A", MAIN, ...args],
    env: { BUILDKITE: "" },
  }).output()
  const decoder = new TextDecoder()
  return {
    code,
    output: decoder.decode(stdout) + decoder.decode(stderr),
  }
}

Deno.test("outside a Buildkite job, help offers only what runs there", async () => {
  const { code, output } = await divvunActions("--help")
  equal(code, 0)
  match(output, /run, ci and sign only run in a Buildkite job/)
  equal(/^\s+run\s/m.test(output), false)
})

Deno.test("outside a Buildkite job, its commands say they need one", async () => {
  for (const command of ["run", "ci", "sign"]) {
    const { code, output } = await divvunActions(command, "x")
    equal(code, 1, command)
    match(output, new RegExp(`${command} only runs in a Buildkite job`))
  }
})

Deno.test("outside a Buildkite job, an unknown command is an error", async () => {
  const { code, output } = await divvunActions("bogus")
  equal(code, 1)
  match(output, /Unexpected option or subcommand: "bogus"/)
})
