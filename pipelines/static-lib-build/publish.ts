import * as path from "@std/path"
import * as builder from "~/builder.ts"
import * as temp from "~/util/temp.ts"

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

  // Repackage each artifact with version in filename and without target prefix
  const repackagedArtifacts: string[] = []

  for (const artifact of artifacts) {
    // Extract target from artifact name (e.g., icu4c_aarch64-apple-darwin.tar.gz -> aarch64-apple-darwin)
    const targetMatch = artifact.match(`${library}_(.+)\\.tar\\.gz$`)
    if (!targetMatch) {
      console.log(`Warning: Could not parse target from ${artifact}`)
      continue
    }
    const target = targetMatch[1]

    console.log(`Processing ${artifact} for target ${target}`)

    // Create temp directory
    const tempDir = await temp.makeTempDir()

    try {
      // Extract original artifact
      await builder.exec("tar", ["-xzf", artifact, "-C", tempDir.path])

      // The extracted directory will be: tempDir/target/library/
      // We want to repackage it as just library/ in the root

      const extractedPath = path.join(tempDir.path, target, library)

      // Check if extraction was successful
      try {
        await Deno.stat(extractedPath)
      } catch {
        console.log(
          `Warning: Expected path ${extractedPath} not found, trying alternative structure`,
        )
        // Maybe it's already in the correct structure?
        const altPath = path.join(tempDir.path, library)
        try {
          await Deno.stat(altPath)
          console.log(`Found library at ${altPath}`)
        } catch {
          console.log(`Error: Could not find library directory in ${artifact}`)
          continue
        }
      }

      // Create new tarball with version in filename
      const versionedArtifact = `${library}-${version}-${target}.tar.gz`

      // Create tarball from the library directory, stripping the target prefix
      await builder.exec("tar", [
        "-czf",
        versionedArtifact,
        "-C",
        path.join(tempDir.path, target),
        library,
      ])

      repackagedArtifacts.push(versionedArtifact)
      console.log(`Created ${versionedArtifact}`)
    } finally {
      // Clean up temp directory
      await Deno.remove(tempDir.path, { recursive: true })
    }
  }

  if (repackagedArtifacts.length === 0) {
    throw new Error("No artifacts were successfully repackaged")
  }

  // Create GitHub release
  const tag = `${library}/${version}`
  console.log(`Creating GitHub release ${tag}`)

  await builder.exec("gh", [
    "release",
    "create",
    tag,
    "--title",
    `${library} ${version}`,
    "--notes",
    `Release ${library} ${version}`,
    ...repackagedArtifacts,
  ])

  console.log(`Successfully published ${library} ${version}`)
}
