import { crypto } from "@std/crypto/crypto"

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
