import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"

const DEFAULT_EXECUTORCH_VERSION = "v1.0.1"
const EXECUTORCH_REPO = "https://github.com/pytorch/executorch.git"
const EXECUTORCH_DIR = "executorch"

function convertVersionToTag(version: string): string {
  // Ensure version starts with 'v'
  return version.startsWith("v") ? version : `v${version}`
}

export async function downloadExecutorchCache(version?: string) {
  const executorchVersion = convertVersionToTag(
    version || DEFAULT_EXECUTORCH_VERSION,
  )
  const tarballName = `executorch_${executorchVersion}.src.tar.gz`
  const executorchUrl =
    `https://github.com/divvun/static-lib-build/releases/download/executorch%2F${executorchVersion}/${tarballName}`

  console.log(`--- Downloading cached ExecuTorch ${executorchVersion}`)

  // Clean up any existing executorch directory
  try {
    await Deno.remove(EXECUTORCH_DIR, { recursive: true })
  } catch {
    // Ignore if directory doesn't exist
  }

  // Try to download pre-built cache
  try {
    await builder.exec("curl", ["-sSfL", executorchUrl, "-o", tarballName])

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

    console.log(`ExecuTorch ${executorchVersion} extracted successfully`)
  } catch {
    console.log(
      `Cache not found for ${executorchVersion}, cloning from source...`,
    )

    // Clone ExecuTorch at specific tag
    console.log(`--- Cloning ExecuTorch at tag ${executorchVersion}...`)
    await builder.exec("git", [
      "clone",
      "--depth",
      "1",
      "--branch",
      executorchVersion,
      EXECUTORCH_REPO,
      EXECUTORCH_DIR,
    ])

    // Initialize submodules
    console.log("--- Initializing submodules...")
    await builder.exec("git", ["submodule", "sync", "--recursive"], {
      cwd: EXECUTORCH_DIR,
    })
    await builder.exec(
      "git",
      ["submodule", "update", "--init", "--recursive", "--depth", "1"],
      { cwd: EXECUTORCH_DIR },
    )

    console.log(`ExecuTorch ${executorchVersion} cloned successfully`)

    // Create cache tarball
    console.log(`--- Creating cache archive: ${tarballName}`)
    await builder.exec("tar", [
      "--exclude=.git",
      "--exclude=.github",
      "-czf",
      tarballName,
      EXECUTORCH_DIR,
    ])

    console.log("Cache archive created, uploading to GitHub release...")

    // Check if release exists
    const releaseTag = `executorch/${executorchVersion}`
    const gh = new GitHub(builder.env.repo)
    const releaseExists = await gh.releaseExists(releaseTag)

    // Create release if it doesn't exist
    if (!releaseExists) {
      console.log(`--- Creating release ${releaseTag}...`)
      await gh.createRelease(releaseTag, [], { verifyTag: false })
    }

    // Upload tarball to release
    console.log(`--- Uploading ${tarballName} to release ${releaseTag}...`)
    await gh.uploadRelease(releaseTag, [tarballName])

    // Clean up tarball
    await Deno.remove(tarballName)

    console.log(
      `ExecuTorch ${executorchVersion} cache created and uploaded successfully`,
    )
  }

  // Upload executorch directory as Buildkite artifact for other build steps to use
  console.log("--- Uploading ExecuTorch directory as Buildkite artifact...")
  const buildkiteArtifact = "executorch.tar.gz"
  await builder.exec("tar", ["-czf", buildkiteArtifact, EXECUTORCH_DIR])
  await builder.uploadArtifacts(buildkiteArtifact)
}
