/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// deno-lint-ignore-file no-explicit-any no-console
import { join } from "jsr:@std/path"

class TempDir implements Disposable {
  path: string

  constructor(path: string) {
    this.path = path
  }

  async [Symbol.dispose]() {
    try {
      await Deno.remove(this.path, { recursive: true })
    } catch (_) {
      // Ignore cleanup errors
    }
  }
}

async function runCodeSign(_inputPath: string, outputPath: string) {
  // TODO: for now we just write garbage to the output path
  await Deno.writeFile(outputPath, new Uint8Array([0x42, 0x42, 0x42, 0x42]))
}

async function handleCodeSign(
  tempDir: TempDir,
  binary: Uint8Array,
): Promise<Uint8Array> {
  const inputPath = join(tempDir.path, `input.exe`)
  const outputPath = join(tempDir.path, `output.exe`)

  await Deno.writeFile(inputPath, binary)
  await runCodeSign(inputPath, outputPath)
  return await Deno.readFile(outputPath)
}

async function handler(
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  if (req.headers.get("content-type") !== "application/octet-stream") {
    return new Response(
      "Invalid content type. Expected application/octet-stream",
      {
        status: 400,
      },
    )
  }

  using tempDir = new TempDir(await Deno.makeTempDir())

  try {
    const binary = new Uint8Array(await req.arrayBuffer())
    if (binary.length === 0) {
      return new Response("Empty binary data", { status: 400 })
    }

    const signedBinary = await handleCodeSign(tempDir, binary)

    return new Response(signedBinary, {
      headers: {
        "content-type": "application/octet-stream",
      },
    })
  } catch (error: unknown) {
    console.error("Error processing request:", error)
    const errorMessage = error instanceof Error ? error.message : String(error)
    return new Response(`Internal server error: ${errorMessage}`, {
      status: 500,
    })
  }
}

export default function serve(port: number, hostname: string, signal?: AbortSignal) {
  return Deno.serve({
    port,
    hostname,
    signal,
  }, handler)
}

if (import.meta.main) {
  const port = parseInt(Deno.env.get("PORT") ?? "8000", 10)
  const hostname = Deno.env.get("HOST") ?? "127.0.0.1"

  console.log(`Starting Windows code signing server on ${hostname}:${port}...`)
  await serve(port, hostname)
}
