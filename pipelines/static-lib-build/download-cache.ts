import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"

const DEFAULT_PYTORCH_VERSION = "v2.8.0"
const PYTORCH_REPO = "https://github.com/pytorch/pytorch.git"
const PYTORCH_DIR = "pytorch"

function convertPytorchVersionToTag(version: string): string {
  // Ensure version starts with 'v'
  return version.startsWith("v") ? version : `v${version}`
}

export async function downloadCache(version?: string) {
  const pytorchVersion = convertPytorchVersionToTag(
    version || DEFAULT_PYTORCH_VERSION,
  )
  const tarballName = `pytorch_${pytorchVersion}.src.tar.gz`
  const pytorchUrl =
    `https://github.com/divvun/static-lib-build/releases/download/pytorch%2F${pytorchVersion}/${tarballName}`

  console.log(`--- Downloading cached PyTorch ${pytorchVersion}`)

  // Clean up any existing pytorch directory
  try {
    await Deno.remove(PYTORCH_DIR, { recursive: true })
  } catch {
    // Ignore if directory doesn't exist
  }

  // Try to download pre-built cache
  try {
    await builder.exec("curl", ["-sSfL", pytorchUrl, "-o", tarballName])

    console.log("Cache found, extracting...")

    // Extract (use bsdtar on Windows because msys tar is broken)
    const isWindows = Deno.build.os === "windows"
    if (isWindows) {
      await builder.exec("bsdtar", ["-xf", tarballName])
    } else {
      await builder.exec("tar", ["xf", tarballName])
    }

    // Clean up tarball
    await Deno.remove(tarballName)

    console.log(`PyTorch ${pytorchVersion} extracted successfully`)
  } catch (error) {
    console.log(
      `Cache not found for ${pytorchVersion}, cloning from source...`,
    )

    // Clone PyTorch at specific tag
    console.log(`Cloning PyTorch at tag ${pytorchVersion}...`)
    await builder.exec("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      pytorchVersion,
      PYTORCH_REPO,
      PYTORCH_DIR,
    ])

    // Initialize submodules
    console.log("Initializing submodules...")
    await builder.exec(
      "git",
      ["submodule", "update", "--init", "--recursive", "--depth", "1"],
      { cwd: PYTORCH_DIR },
    )

    // Fetch optional submodules (eigen)
    console.log("Fetching optional submodules (eigen)...")
    await builder.exec(
      "python3",
      ["tools/optional_submodules.py", "checkout_eigen"],
      { cwd: PYTORCH_DIR },
    )

    console.log(`PyTorch ${pytorchVersion} cloned successfully`)

    // Create cache tarball
    console.log(`Creating cache archive: ${tarballName}`)
    await builder.exec("tar", [
      "--exclude=.git",
      "--exclude=.github",
      "-czf",
      tarballName,
      PYTORCH_DIR,
    ])

    console.log("Cache archive created, uploading to GitHub release...")

    // Check if release exists
    const releaseTag = `pytorch/${pytorchVersion}`
    const gh = new GitHub(builder.env.repo)
    const releaseExists = await gh.releaseExists(releaseTag)

    // Create release if it doesn't exist
    if (!releaseExists) {
      console.log(`Creating release ${releaseTag}...`)
      await gh.createRelease(releaseTag, [], { verifyTag: false })
    }

    // Upload tarball to release
    console.log(`Uploading ${tarballName} to release ${releaseTag}...`)
    await gh.uploadRelease(releaseTag, [tarballName])

    // Clean up tarball
    await Deno.remove(tarballName)

    console.log(
      `PyTorch ${pytorchVersion} cache created and uploaded successfully`,
    )
  }

  // Upload pytorch directory as Buildkite artifact for other build steps to use
  if (Deno.env.get("BUILDKITE")) {
    console.log("Creating Buildkite artifact from pytorch directory...")
    const buildkiteArtifact = "pytorch.tar.gz"
    await builder.exec("tar", ["-czf", buildkiteArtifact, PYTORCH_DIR])
    await builder.exec("buildkite-agent", [
      "artifact",
      "upload",
      buildkiteArtifact,
    ])
    console.log("PyTorch source uploaded as Buildkite artifact")
  }
}
