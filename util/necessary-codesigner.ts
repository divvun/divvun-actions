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

const SIGN_URL = "https://sign.necessary.nu/windows/sign"
const SIGN_ATTEMPTS = 4

// The service answers 5xx when its HSM or timestamp authority fails for a
// moment and asks the caller to try again; 4xx means the request itself is
// wrong, so only 5xx and network errors are retried, with backoff.
async function requestSignature(
  tosignData: Uint8Array<ArrayBuffer>,
  bearerToken: string,
): Promise<Uint8Array> {
  let failure = ""
  for (let attempt = 1; attempt <= SIGN_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(SIGN_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${bearerToken}` },
        body: tosignData,
      })
      if (response.ok) {
        return new Uint8Array(await response.arrayBuffer())
      }
      const body = (await response.text()).trim()
      failure = `Signing service returned ${response.status}${
        body ? `: ${body}` : ""
      }`
      if (response.status < 500) {
        throw new Error(failure)
      }
    } catch (e) {
      if (e instanceof Error && e.message === failure) throw e
      failure = `Signing service request failed: ${e}`
    }
    if (attempt < SIGN_ATTEMPTS) {
      const delay = 5000 * 2 ** (attempt - 1)
      console.error(`${failure}; retrying in ${delay / 1000}s`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error(`${failure} (after ${SIGN_ATTEMPTS} attempts)`)
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
  await Deno.writeFile(
    signedPath,
    await requestSignature(tosignData, bearerToken),
  )

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
