import * as path from "@std/path"
import * as builder from "~/builder.ts"

export async function publishLibrary(library: string, version: string) {
  console.log(`Publishing ${library} ${version}`)

  // Download all artifacts
  await builder.downloadArtifacts(`target/${library}_*.tar.gz`, ".")

  // Find all downloaded artifacts
  const artifacts: string[] = []
  for await (const entry of Deno.readDir("target")) {
    if (
      entry.isFile && entry.name.startsWith(`${library}_`) &&
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
    const targetMatch = artifact.match(`${library}_(.+)\\.tar\\.gz$`)
    if (!targetMatch) {
      console.log(`Warning: Could not parse target from ${artifact}`)
      continue
    }
    const target = targetMatch[1]

    // Create new filename with version
    const versionedArtifact = `${library}_${version}_${target}.tar.gz`

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
  console.log(`Creating GitHub release ${tag}`)

  await builder.exec("gh", [
    "release",
    "create",
    tag,
    ...versionedArtifacts,
  ])

  console.log(`Successfully published ${library} ${version}`)
}
