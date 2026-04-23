// deno-lint-ignore-file no-console
import * as path from "@std/path"
import { renderImage } from "./lib/image.ts"
import type { ImageDef } from "./lib/image.ts"

const HERE = path.dirname(path.fromFileUrl(import.meta.url))
const IMAGES_DIR = path.join(HERE, "images")

async function loadImages(): Promise<ImageDef[]> {
  const images: ImageDef[] = []
  for await (const entry of Deno.readDir(IMAGES_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue
    const mod = await import(path.join(IMAGES_DIR, entry.name))
    const def = mod.default as ImageDef | undefined
    if (!def) {
      throw new Error(`${entry.name} has no default export`)
    }
    images.push(def)
  }
  images.sort((a, b) => a.target.localeCompare(b.target))
  return images
}

function outputPath(target: string): string {
  return path.join(HERE, `Dockerfile.${target}`)
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(p)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null
    throw err
  }
}

function printHelp() {
  console.log(`Usage: deno task docker:gen [OPTIONS]

Options:
  --check              Exit non-zero if any generated Dockerfile is out of date.
  --list               Print a manifest of each image.
  --only=<target>      Restrict to one image (e.g. --only=alpine).
  --print-ref=<target> Print the ghcr.io image ref for <target> and exit.
  -h, --help           Show this help.`)
}

function printManifest(images: ImageDef[]) {
  for (const img of images) {
    console.log(
      `─── ${img.target} ${"─".repeat(Math.max(0, 60 - img.target.length))}`,
    )
    console.log(`  base:     ${img.base}`)
    console.log(`  platform: ${img.platform}`)
    if (img.shell) console.log(`  shell:    ${img.shell}`)
    const apk = img.apkPackages?.length ?? 0
    const apt = img.aptPackages?.length ?? 0
    if (apk) console.log(`  apk:      ${apk} packages`)
    if (apt) console.log(`  apt:      ${apt} packages`)
    if (img.preInstall?.length) {
      console.log(`  pre-install:`)
      for (const t of img.preInstall) console.log(`    - ${t.name}`)
    }
    console.log(`  tools (${img.tools.length}):`)
    for (const t of img.tools) console.log(`    - ${t.name}`)
    console.log()
  }
}

async function main() {
  if (Deno.args.includes("-h") || Deno.args.includes("--help")) {
    printHelp()
    return
  }

  const check = Deno.args.includes("--check")
  const list = Deno.args.includes("--list")
  const only = Deno.args.find((a) => a.startsWith("--only="))?.slice(7)
  const printRef = Deno.args.find((a) => a.startsWith("--print-ref="))?.slice(
    12,
  )

  const images = await loadImages()

  if (printRef) {
    const match = images.find((i) => i.target === printRef)
    if (!match) {
      console.error(`No image matches --print-ref=${printRef}`)
      Deno.exit(2)
    }
    console.log(match.imageRef)
    return
  }

  const filtered = only ? images.filter((i) => i.target === only) : images

  if (only && filtered.length === 0) {
    console.error(`No image matches --only=${only}`)
    Deno.exit(2)
  }

  if (list) {
    printManifest(filtered)
    return
  }

  let drift = 0
  for (const img of filtered) {
    const rendered = renderImage(img)
    const dest = outputPath(img.target)
    if (check) {
      const existing = await readIfExists(dest)
      if (existing !== rendered) {
        console.error(`DRIFT: ${path.basename(dest)} is out of date.`)
        drift++
      } else {
        console.log(`OK:    ${path.basename(dest)}`)
      }
    } else {
      await Deno.writeTextFile(dest, rendered)
      console.log(`WROTE: ${path.basename(dest)}`)
    }
  }

  if (check && drift > 0) {
    console.error(`\n${drift} file(s) out of date. Run: deno task docker:gen`)
    Deno.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
