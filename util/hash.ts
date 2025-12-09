import { crypto } from "@std/crypto/crypto"
import { SecretsStore } from "./openbao.ts"
import { makeTempFile } from "./temp.ts"

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function blake3Hash(filePath: string): Promise<string> {
  const file = await Deno.open(filePath, { read: true })
  const hashBuffer = await crypto.subtle.digest(
    "BLAKE3",
    file.readable as unknown as AsyncIterable<BufferSource>,
  )
  return toHex(new Uint8Array(hashBuffer))
}

/**
 * Generate a BLAKE3SUMS file using the b3sum command line tool.
 * Format: `<hash>  <filename>` (two spaces, like sha256sum)
 */
export async function generateBlake3Sums(
  files: string[],
  outputPath: string = "BLAKE3SUMS",
): Promise<void> {
  const cmd = new Deno.Command("b3sum", {
    args: files,
    stdout: "piped",
    stderr: "piped",
  })

  const { code, stdout, stderr } = await cmd.output()

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr)
    throw new Error(`b3sum failed with code ${code}: ${errorText}`)
  }

  await Deno.writeFile(outputPath, stdout)
}

/**
 * Sign a file using minisign.
 * The password is piped to stdin.
 */
export async function minisign(
  filePath: string,
  privateKeyPath: string,
  password: string,
): Promise<void> {
  const cmd = new Deno.Command("minisign", {
    args: ["-S", "-s", privateKeyPath, "-m", filePath],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })

  const process = cmd.spawn()

  const writer = process.stdin.getWriter()
  await writer.write(new TextEncoder().encode(password + "\n"))
  await writer.close()

  const { code, stderr } = await process.output()

  if (code !== 0) {
    const errorText = new TextDecoder().decode(stderr)
    throw new Error(`minisign failed with code ${code}: ${errorText}`)
  }
}

/**
 * Create signed checksums for a list of files.
 * Generates a BLAKE3SUMS file and signs it with minisign.
 * Returns paths to both the checksum file and the signature file.
 */
export async function createSignedChecksums(
  files: string[],
  secrets: SecretsStore,
): Promise<{ checksumFile: string; signatureFile: string }> {
  const checksumFile = "BLAKE3SUMS"
  const signatureFile = "BLAKE3SUMS.minisig"

  // Generate checksums
  await generateBlake3Sums(files, checksumFile)

  // Get signing credentials
  const privateKey = secrets.get("minisign/privateKey")
  const password = secrets.get("minisign/password")

  // Write private key to temp file and sign
  using keyFile = await makeTempFile({ suffix: ".key" })
  await Deno.writeTextFile(keyFile.path, privateKey)

  await minisign(checksumFile, keyFile.path, password)

  return { checksumFile, signatureFile }
}
