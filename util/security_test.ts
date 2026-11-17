import { exists } from "@std/fs"
import * as path from "@std/path"
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict"
import { makeTempDir } from "./temp.ts"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/divvun-dev-keyboard.git")
Deno.env.delete("BUILDKITE_PLUGINS")

const { jobKeychainName, parseKeychainSearchList, withJobKeychain } =
  await import("./security.ts")

Deno.test("parseKeychainSearchList reads the quoted paths security prints", () => {
  const stdout = [
    '    "/Users/admin/Library/Keychains/login.keychain-db"',
    '    "/Users/admin/Library/Keychains/with space.keychain-db"',
    "",
  ].join("\n")

  deepStrictEqual(parseKeychainSearchList(stdout), [
    "/Users/admin/Library/Keychains/login.keychain-db",
    "/Users/admin/Library/Keychains/with space.keychain-db",
  ])
  deepStrictEqual(parseKeychainSearchList(""), [])
})

Deno.test("jobKeychainName is the agent's own, and safe as a file name", () => {
  strictEqual(
    jobKeychainName("vm-builder-ab12c-1"),
    "divvun-ci-vm-builder-ab12c-1",
  )
  strictEqual(jobKeychainName("my agent/2"), "divvun-ci-my-agent-2")
  strictEqual(jobKeychainName(undefined), `divvun-ci-pid-${Deno.pid}`)
})

async function run(command: string, args: string[]) {
  const result = await new Deno.Command(command, { args }).output()
  const decoder = new TextDecoder()
  return {
    success: result.success,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  }
}

async function searchList(): Promise<string[]> {
  const { stdout } = await run("security", ["list-keychains", "-d", "user"])
  return parseKeychainSearchList(stdout)
}

// Creates a keychain and rewrites this user's keychain search list for real,
// so it runs only when asked: RUN_KEYCHAIN_TESTS=1 on a Mac.
Deno.test({
  name: "withJobKeychain makes, lists and deletes the keychain",
  ignore: Deno.build.os !== "darwin" ||
    Deno.env.get("RUN_KEYCHAIN_TESTS") !== "1",
  async fn() {
    // The password is redacted through buildkite-agent, which a Mac running
    // this test need not have.
    await using bin = await makeTempDir({ prefix: "security-test-bin-" })
    await Deno.writeTextFile(
      path.join(bin.path, "buildkite-agent"),
      "#!/bin/sh\ncat >/dev/null\n",
      { mode: 0o755 },
    )
    Deno.env.set("PATH", `${bin.path}:${Deno.env.get("PATH")}`)
    Deno.env.set(
      "BUILDKITE_AGENT_NAME",
      `security-test-${crypto.randomUUID().slice(0, 8)}`,
    )

    const before = await searchList()
    const leftover = path.join(
      Deno.env.get("HOME")!,
      "Library",
      "Keychains",
      `${jobKeychainName()}.keychain-db`,
    )

    try {
      // What a killed job leaves: a keychain whose password is lost.
      const made = await run("security", [
        "create-keychain",
        "-p",
        "lost",
        leftover,
      ])
      ok(made.success, made.stderr)

      const seen = await withJobKeychain(async (keychain) => {
        strictEqual(keychain.path, leftover)
        strictEqual(keychain.name, `${jobKeychainName()}.keychain`)
        ok(await exists(keychain.path))
        deepStrictEqual(await searchList(), [keychain.path, ...before])

        // Answers without a prompt only for an unlocked keychain.
        const info = await run("security", [
          "show-keychain-info",
          keychain.path,
        ])
        ok(info.success, info.stderr)
        match(info.stderr, /no-timeout/)
        return keychain.path
      })

      strictEqual(await exists(seen), false)
      deepStrictEqual(await searchList(), before)
    } finally {
      await run("security", ["delete-keychain", leftover])
    }
  },
})
