import * as builder from "~/builder.ts"

const PYTORCH_VERSION = "v2.8.0"
const PYTORCH_URL =
  `https://github.com/divvun/pytorch-static-build/releases/download/pytorch%2F${PYTORCH_VERSION}/pytorch-${PYTORCH_VERSION}.src.tar.gz`
const TARBALL = "pytorch.tar.gz"

export async function downloadCache() {
  console.log(`--- Downloading cached PyTorch ${PYTORCH_VERSION}`)

  // Clean up any existing pytorch directory
  try {
    await Deno.remove("pytorch", { recursive: true })
  } catch {
    // Ignore if directory doesn't exist
  }

  // Download tarball
  await builder.exec("curl", ["-sSfL", PYTORCH_URL, "-o", TARBALL])

  // Extract (use bsdtar on Windows because msys tar is broken)
  const isWindows = Deno.build.os === "windows"
  if (isWindows) {
    await builder.exec("bsdtar", ["-xf", TARBALL])
  } else {
    await builder.exec("tar", ["xf", TARBALL])
  }

  // Clean up tarball
  await Deno.remove(TARBALL)

  console.log(`PyTorch ${PYTORCH_VERSION} extracted successfully`)
}
