import { ok, strictEqual } from "node:assert/strict"
import * as path from "@std/path"
import { createSignedChecksums } from "./hash.ts"
import { SecretsStore } from "./openbao.ts"
import { makeTempDir } from "./temp.ts"

// Integration test: requires b3sum and minisign on PATH. Uses a disposable key.
Deno.test("release checksums use portable names, verify, and detect tampering", async () => {
  using scratch = await makeTempDir({ prefix: "signed-checksums-test-" })
  try {
    const key = path.join(scratch.path, "test.key")
    const pub = path.join(scratch.path, "test.pub")
    const generation = await new Deno.Command("minisign", {
      args: ["-G", "-W", "-s", key, "-p", pub],
      stdout: "piped",
      stderr: "piped",
    }).output()
    strictEqual(generation.code, 0, new TextDecoder().decode(generation.stderr))
    const artifact = "divvun-wind_x86-64-pc-windows-msvc_0.1.0.exe"
    await Deno.writeTextFile(
      path.join(scratch.path, artifact),
      "test artifact\n",
    )
    const { checksumFile, signatureFile } = await createSignedChecksums(
      [artifact],
      new SecretsStore({
        "minisign/privateKey": await Deno.readTextFile(key),
        "minisign/password": "",
      }),
      scratch.path,
    )
    strictEqual(checksumFile, path.join(scratch.path, "BLAKE3SUMS"))
    strictEqual(signatureFile, `${checksumFile}.minisig`)
    ok(new RegExp(`^[a-f0-9]{64}  ${artifact.replaceAll(".", "\\.")}\\r?\\n$`)
      .test(await Deno.readTextFile(checksumFile)))
    const verify = () =>
      new Deno.Command("minisign", {
        args: ["-V", "-p", pub, "-m", checksumFile],
        stdout: "piped",
        stderr: "piped",
      }).output()
    strictEqual((await verify()).code, 0)
    const check = () =>
      new Deno.Command("b3sum", {
        args: ["--check", "BLAKE3SUMS"],
        cwd: scratch.path,
        stdout: "piped",
        stderr: "piped",
      }).output()
    strictEqual((await check()).code, 0)
    await Deno.writeTextFile(path.join(scratch.path, artifact), "tampered\n")
    ok((await check()).code !== 0)
    await Deno.writeTextFile(checksumFile, "tampered\n")
    ok((await verify()).code !== 0)
  } finally {
    ok(
      path.isAbsolute(scratch.path) &&
        path.basename(scratch.path).startsWith("signed-checksums-test-"),
    )
    await Deno.remove(scratch.path, { recursive: true })
  }
})
