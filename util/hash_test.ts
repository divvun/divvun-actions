import { ok, rejects, strictEqual, throws } from "node:assert/strict"
import * as path from "@std/path"
import { createSignedChecksums, type Release, trustedComment } from "./hash.ts"
import { makeTempDir } from "./temp.ts"

const COMMIT = "4f2c0a9e7b1d3c5e6f8a9b0c1d2e3f4a5b6c7d8e"

const RELEASE: Release = {
  repo: "giellalt/lang-sme",
  tag: "speller-sme/v4.5.2",
  package: "main/speller-sme",
  version: "4.5.2",
  commit: COMMIT,
}

Deno.test("the trusted comment names the release in quoted Styx", () => {
  strictEqual(
    trustedComment(RELEASE),
    `repo "giellalt/lang-sme", tag "speller-sme/v4.5.2", package "main/speller-sme", version "4.5.2", commit "${COMMIT}"`,
  )
  const { package: _, ...tool } = RELEASE
  strictEqual(
    trustedComment({ ...tool, repo: "divvun/box", tag: "v0.3.0", version: "0.3.0" }),
    `repo "divvun/box", tag "v0.3.0", version "0.3.0", commit "${COMMIT}"`,
  )
  throws(() => trustedComment({ ...RELEASE, tag: 'v1"2' }))
  throws(() => trustedComment({ ...RELEASE, version: "" }))
})

Deno.test("BLAKE3SUMS takes only bare file names", async () => {
  const key = { secretKey: "", password: "" }
  await rejects(createSignedChecksums(["dist/a.tgz"], key, RELEASE))
  await rejects(createSignedChecksums(["a b.tgz"], key, RELEASE))
  await rejects(createSignedChecksums(["a.tgz", "a.tgz"], key, RELEASE))
})

// Integration test: requires b3sum and minisign on PATH. Uses a disposable key.
Deno.test("release checksums use portable names, verify with the comment, and detect tampering", async () => {
  using scratch = await makeTempDir({ prefix: "signed-checksums-test-" })
  try {
    const key = path.join(scratch.path, "test.key")
    const pub = path.join(scratch.path, "test.pub")
    const password = "test password"
    const generation = new Deno.Command("minisign", {
      args: ["-G", "-s", key, "-p", pub],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn()
    const writer = generation.stdin.getWriter()
    await writer.write(new TextEncoder().encode(`${password}\n${password}\n`))
    await writer.close()
    const generated = await generation.output()
    strictEqual(generated.code, 0, new TextDecoder().decode(generated.stderr))
    const artifact = "divvun-wind_x86-64-pc-windows-msvc_0.1.0.exe"
    await Deno.writeTextFile(
      path.join(scratch.path, artifact),
      "test artifact\n",
    )
    const { checksumFile, signatureFile } = await createSignedChecksums(
      [artifact],
      { secretKey: await Deno.readTextFile(key), password },
      RELEASE,
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
    const verified = await verify()
    strictEqual(verified.code, 0)
    ok(
      new TextDecoder().decode(verified.stdout).includes(
        `Trusted comment: ${trustedComment(RELEASE)}`,
      ),
    )
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
