import { makeTempDir } from "~/util/temp.ts"
import * as path from "@std/path"

// rsigncode is a Rust port of osslsigncode (see
// ~/git/necessary/divvun/rsigncode). It supports the same detached-signing
// workflow but uses long-form flags (--in / --out / --sigin) and ships as a
// single static binary, so we don't depend on chocolatey's stale osslsigncode.

async function runSigncode(
  subcommand: string,
  args: string[],
): Promise<void> {
  const res = await new Deno.Command("rsigncode", {
    args: [subcommand, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output()
  if (!res.success) {
    const stderr = new TextDecoder().decode(res.stderr).trim()
    const stdout = new TextDecoder().decode(res.stdout).trim()
    throw new Error(
      `rsigncode ${subcommand} failed (exit ${res.code})\n` +
        `  stderr: ${stderr || "(empty)"}\n` +
        `  stdout: ${stdout || "(empty)"}`,
    )
  }
}

export async function necessaryCodeSign(
  inputFile: string,
  bearerToken: string,
) {
  using tempDir = await makeTempDir({ prefix: "codesign-" })
  const tosignPath = path.join(tempDir.path, "tosign.bin")
  const signedPath = path.join(tempDir.path, "signed.bin")
  const outputFile = path.join(tempDir.path, "signed.exe")

  // Step 1: Extract data to sign
  await runSigncode("extract-data", [
    "--in",
    inputFile,
    "--out",
    tosignPath,
  ])

  // Step 2: Send to signing service
  const tosignData = await Deno.readFile(tosignPath)
  const response = await fetch("https://sign.necessary.nu/windows/sign", {
    method: "POST",
    headers: { "Authorization": `Bearer ${bearerToken}` },
    body: tosignData,
  })
  if (!response.ok) {
    throw new Error(`Signing service returned ${response.status}`)
  }
  await Deno.writeFile(signedPath, new Uint8Array(await response.arrayBuffer()))

  // Step 3: Attach signature to original file
  await runSigncode("attach-signature", [
    "--sigin",
    signedPath,
    "--in",
    inputFile,
    "--out",
    outputFile,
  ])

  // Verify the signature was correctly applied
  await runSigncode("verify", ["--in", outputFile])

  await Deno.copyFile(outputFile, inputFile)
}
