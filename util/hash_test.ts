import {
  deepStrictEqual,
  ok,
  rejects,
  strictEqual,
  throws,
} from "node:assert/strict"
import * as path from "@std/path"
import {
  blake3Hash,
  checkRelease,
  commentFields,
  createSignedChecksums,
  type Release,
  trustedComment,
} from "./hash.ts"
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
    trustedComment({
      ...tool,
      repo: "divvun/box",
      tag: "v0.3.0",
      version: "0.3.0",
    }),
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

async function run(command: string, args: string[], cwd: string) {
  const { code, stderr } = await new Deno.Command(command, {
    args,
    cwd,
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output()
  if (code !== 0) {
    throw new Error(
      `${command} failed: ${new TextDecoder().decode(stderr)}`,
    )
  }
}

/** A key, and a release of main/pahkat 3.0.0 holding one box signed with it. */
async function signed(dir: string) {
  await run("minisign", ["-G", "-W", "-p", "ci.pub", "-s", "ci.key"], dir)
  const key = (await Deno.readTextFile(path.join(dir, "ci.pub")))
    .trim().split("\n")[1]
  const file = "pahkat_3.0.0_linux_x86_64.pkt.box"
  const saved = path.join(dir, "pahkat.pkt.box")
  await Deno.writeTextFile(saved, "the CLI")
  const hash = await blake3Hash(saved)
  const sums = path.join(dir, "BLAKE3SUMS")
  await Deno.writeTextFile(sums, `${hash}  ${file}\n`)
  const comment = trustedComment({
    repo: "divvun/pahkat-next",
    tag: "dev-latest",
    package: "main/pahkat",
    version: "3.0.0",
    commit: COMMIT,
  })
  await run("minisign", [
    "-S",
    "-s",
    "ci.key",
    "-m",
    "BLAKE3SUMS",
    "-t",
    comment,
  ], dir)
  return {
    sums,
    signature: `${sums}.minisig`,
    saved,
    file,
    name: "main/pahkat",
    version: "3.0.0",
    key,
  }
}

Deno.test("a fetched release runs only when its attestation holds", async () => {
  using dir = await makeTempDir()
  const release = await signed(dir.path)
  await checkRelease(release)

  await rejects(checkRelease({ ...release, version: "3.0.1" }), /signed for/)
  await rejects(
    checkRelease({ ...release, name: "main/kbdgen" }),
    /signed for/,
  )
  await rejects(
    checkRelease({ ...release, file: "other.pkt.box" }),
    /not the file its BLAKE3SUMS lists/,
  )
  await rejects(
    checkRelease({
      ...release,
      key: "RWQkp7YVzweZBSfw15ZgnFk5JC2XL7RpuRMf+Py/i+THc1JMVpUzBR3r",
    }),
    /does not verify/,
  )

  await Deno.writeTextFile(release.saved, "another CLI")
  await rejects(checkRelease(release), /not the file its BLAKE3SUMS lists/)
})

Deno.test("a trusted comment's fields are read quoted, as signed, or bare", () => {
  const expected = new Map([
    ["repo", RELEASE.repo],
    ["tag", RELEASE.tag],
    ["package", RELEASE.package!],
    ["version", RELEASE.version],
    ["commit", COMMIT],
  ])
  deepStrictEqual(commentFields(trustedComment(RELEASE)), expected)
  deepStrictEqual(
    commentFields(
      `repo giellalt/lang-sme, tag speller-sme/v4.5.2, package main/speller-sme, version 4.5.2, commit ${COMMIT}`,
    ),
    expected,
  )
  deepStrictEqual(commentFields('package "main/pahkat" junk'), new Map())
  deepStrictEqual(commentFields(""), new Map())
})
