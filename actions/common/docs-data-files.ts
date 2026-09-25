/**
 * Pure file helpers for the docs-data publisher (`docs-data.ts`), kept apart
 * from it so they can be tested without a CI environment (`builder.ts` throws
 * on import outside one).
 */

/**
 * Largest file `publishGeneratedDocsData` will push. GitHub rejects any file
 * over 100 MiB (and rejects the whole push with it); stay a little under.
 */
export const MAX_PUBLISH_BYTES = 95 * 1024 * 1024

export function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

/** Split `files` into those at most `max` bytes and those over it. */
export function partitionBySize<T extends { size: number }>(
  files: T[],
  max: number,
): { publishable: T[]; oversized: T[] } {
  const publishable: T[] = []
  const oversized: T[] = []
  for (const f of files) (f.size > max ? oversized : publishable).push(f)
  return { publishable, oversized }
}

/**
 * Minify the JSON file `src` and write it gzipped to `dest`. Minifying first
 * roughly halves what the browser has to inflate and parse, on top of a
 * somewhat smaller download. Returns the byte counts of each stage.
 */
export async function writeMinifiedGzip(
  src: string,
  dest: string,
): Promise<{ full: number; minified: number; gzipped: number }> {
  const text = await Deno.readTextFile(src)
  const minified = new TextEncoder().encode(JSON.stringify(JSON.parse(text)))
  const out = await Deno.create(dest)
  await ReadableStream.from([minified])
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(out.writable)
  return {
    full: (await Deno.stat(src)).size,
    minified: minified.byteLength,
    gzipped: (await Deno.stat(dest)).size,
  }
}
