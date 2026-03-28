import { makeTempDir } from "~/util/temp.ts"
import * as path from "@std/path"

export async function necessaryCodeSign(
  inputFile: string,
  bearerToken: string,
) {
  using tempDir = await makeTempDir({ prefix: "codesign-" })
  const tosignPath = path.join(tempDir.path, "tosign.bin")
  const signedPath = path.join(tempDir.path, "signed.bin")
  const outputFile = path.join(tempDir.path, "signed.exe")

  // Step 1: Extract data to sign
  const extractProc = new Deno.Command("osslsigncode", {
    args: ["extract-data", "-in", inputFile, "-out", tosignPath],
  }).spawn()
  if (!(await extractProc.status).success) {
    throw new Error("osslsigncode extract-data failed")
  }

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
  const attachProc = new Deno.Command("osslsigncode", {
    args: [
      "attach-signature",
      "-sigin",
      signedPath,
      "-in",
      inputFile,
      "-out",
      outputFile,
    ],
  }).spawn()
  if (!(await attachProc.status).success) {
    throw new Error("osslsigncode attach-signature failed")
  }

  // Verify the signature was correctly applied
  const verifyProc = new Deno.Command("osslsigncode", {
    args: ["verify", "-in", outputFile],
  }).spawn()
  if (!(await verifyProc.status).success) {
    throw new Error("osslsigncode verify failed: signature verification failed")
  }

  await Deno.copyFile(outputFile, inputFile)
}
