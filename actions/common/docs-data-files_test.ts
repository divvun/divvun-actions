import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import * as path from "@std/path"
import { makeTempDir } from "~/util/temp.ts"
import { partitionBySize, writeMinifiedGzip } from "./docs-data-files.ts"

Deno.test("partitionBySize holds back files over the limit", () => {
  const files = [
    { path: "a.json", size: 10 },
    { path: "b.json.gz", size: 101 },
    { path: "c.svg", size: 100 },
  ]
  const { publishable, oversized } = partitionBySize(files, 100)
  deepStrictEqual(publishable.map((f) => f.path), ["a.json", "c.svg"])
  deepStrictEqual(oversized.map((f) => f.path), ["b.json.gz"])
})

Deno.test("writeMinifiedGzip round-trips the JSON and reports sizes", async () => {
  using scratch = await makeTempDir({ prefix: "docs-data-test-" })
  const report = {
    summary: { top1: 1 },
    results: Array.from({ length: 500 }, (_, i) => ({
      input: `wörd${i}`,
      suggestions: [{ value: "word", weight: 22.5 }],
    })),
  }
  const src = path.join(scratch.path, "report.json")
  const dest = path.join(scratch.path, "speller-accuracy.json.gz")
  await Deno.writeTextFile(src, JSON.stringify(report, null, 2))

  const sizes = await writeMinifiedGzip(src, dest)

  strictEqual(sizes.full, (await Deno.stat(src)).size)
  strictEqual(sizes.gzipped, (await Deno.stat(dest)).size)
  ok(sizes.minified < sizes.full)
  ok(sizes.gzipped < sizes.minified)

  const inflated = await new Response(
    (await Deno.open(dest)).readable.pipeThrough(
      new DecompressionStream("gzip"),
    ),
  ).text()
  strictEqual(inflated, JSON.stringify(report))
})
