import { exists, existsSync } from "@std/fs"
import { ok, strictEqual } from "node:assert/strict"
import { makeTempDir, makeTempFileSync } from "./temp.ts"

Deno.test("DisposablePath removes a temporary file when disposed", () => {
  let tempPath: string
  let temp: Awaited<ReturnType<typeof makeTempFileSync>>

  {
    using disposable = makeTempFileSync({ prefix: "disposable-path-test-" })
    temp = disposable
    tempPath = disposable.path
    ok(existsSync(tempPath))
  }

  strictEqual(existsSync(tempPath!), false)

  // Explicit resource management may invoke cleanup only once, but disposal
  // should remain safe if a caller invokes it again.
  temp![Symbol.dispose]()
})

Deno.test("DisposablePath recursively removes a temporary directory", async () => {
  let tempPath: string
  let temp: Awaited<ReturnType<typeof makeTempDir>>

  {
    await using disposable = await makeTempDir({
      prefix: "disposable-path-test-",
    })
    temp = disposable
    tempPath = disposable.path
    await Deno.writeTextFile(`${tempPath}/nested.txt`, "test")
    ok(await exists(`${tempPath}/nested.txt`))
  }

  strictEqual(await exists(tempPath!), false)
  await temp![Symbol.asyncDispose]()
})

Deno.test("DisposablePath tolerates a target that was already removed", async () => {
  const file = makeTempFileSync({ prefix: "disposable-path-test-" })
  Deno.removeSync(file.path)
  file[Symbol.dispose]()

  const directory = await makeTempDir({ prefix: "disposable-path-test-" })
  await Deno.remove(directory.path, { recursive: true })
  await directory[Symbol.asyncDispose]()
})
