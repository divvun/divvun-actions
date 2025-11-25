import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"

export async function publishLibrary(library: string, version: string) {
  console.log(`Publishing ${library} ${version}`)

  // Download all artifacts (both Unix and Windows path separators)
  await builder.downloadArtifacts(`target/${library}_*.tar.gz`, ".")

  // SLEEF needs -build artifacts for cross-compilation
  if (library === "sleef") {
    try {
      await builder.downloadArtifacts(`target/${library}-build_*.tar.gz`, ".")
    } catch {
      // -build artifacts may not exist for all targets
    }
  }

  try {
    await builder.downloadArtifacts(`target\\${library}_*.tar.gz`, ".")
  } catch {
    // Ignore errors from Windows-style paths if none exist
  }

  // Find all downloaded artifacts
  const artifacts: string[] = []
  for await (const entry of Deno.readDir("target")) {
    if (
      entry.isFile &&
      (entry.name.startsWith(`${library}_`) ||
        (library === "sleef" && entry.name.startsWith(`${library}-build_`))) &&
      entry.name.endsWith(".tar.gz")
    ) {
      artifacts.push(path.join("target", entry.name))
    }
  }

  console.log(`Found ${artifacts.length} artifacts`)

  // Rename each artifact with version in filename
  const versionedArtifacts: string[] = []

  for (const artifact of artifacts) {
    // Extract target from artifact name (e.g., icu4c_aarch64-apple-darwin.tar.gz -> aarch64-apple-darwin)
    // Also handle -build artifacts (e.g., sleef-build_x86_64-unknown-linux-gnu.tar.gz)
    const isBuildArtifact = artifact.includes(`${library}-build_`)
    const pattern = isBuildArtifact
      ? `${library}-build_(.+)\\.tar\\.gz$`
      : `${library}_(.+)\\.tar\\.gz$`
    const targetMatch = artifact.match(pattern)
    if (!targetMatch) {
      console.log(`Warning: Could not parse target from ${artifact}`)
      continue
    }
    const target = targetMatch[1]

    // Create new filename with version
    const versionedFilename = isBuildArtifact
      ? `${library}-build_${version}_${target}.tar.gz`
      : `${library}_${version}_${target}.tar.gz`
    const versionedArtifact = path.join("target", versionedFilename)

    // Rename the artifact
    await Deno.rename(artifact, versionedArtifact)

    versionedArtifacts.push(versionedArtifact)
    console.log(`Renamed ${artifact} to ${versionedArtifact}`)
  }

  if (versionedArtifacts.length === 0) {
    throw new Error("No artifacts were successfully renamed")
  }

  // Create GitHub release
  const tag = `${library}/${version}`
  const gh = new GitHub(builder.env.repo)

  const exists = await gh.releaseExists(tag)
  if (!exists) {
    console.log(`Creating GitHub release ${tag}`)
    await gh.createRelease(tag, [], { verifyTag: false })
  }

  console.log(`Uploading ${versionedArtifacts.length} artifacts to ${tag}`)
  await gh.uploadRelease(tag, versionedArtifacts)

  console.log(`Successfully published ${library} ${version}`)
}
