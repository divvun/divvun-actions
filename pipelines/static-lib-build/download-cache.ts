import * as builder from "~/builder.ts"

const DEFAULT_PYTORCH_VERSION = "v2.8.0"
const TARBALL = "pytorch.tar.gz"

function convertPytorchVersionToTag(version: string): string {
  // Ensure version starts with 'v'
  return version.startsWith("v") ? version : `v${version}`
}

export async function downloadCache(version?: string) {
  const pytorchVersion = convertPytorchVersionToTag(
    version || DEFAULT_PYTORCH_VERSION,
  )
  const pytorchUrl =
    `https://github.com/divvun/pytorch-static-build/releases/download/pytorch%2F${pytorchVersion}/pytorch-${pytorchVersion}.src.tar.gz`

  console.log(`--- Downloading cached PyTorch ${pytorchVersion}`)

  // Clean up any existing pytorch directory
  try {
    await Deno.remove("pytorch", { recursive: true })
  } catch {
    // Ignore if directory doesn't exist
  }

  // Download tarball
  await builder.exec("curl", ["-sSfL", pytorchUrl, "-o", TARBALL])

  // Extract (use bsdtar on Windows because msys tar is broken)
  const isWindows = Deno.build.os === "windows"
  if (isWindows) {
    await builder.exec("bsdtar", ["-xf", TARBALL])
  } else {
    await builder.exec("tar", ["xf", TARBALL])
  }

  // Clean up tarball
  await Deno.remove(TARBALL)

  console.log(`PyTorch ${pytorchVersion} extracted successfully`)
}
