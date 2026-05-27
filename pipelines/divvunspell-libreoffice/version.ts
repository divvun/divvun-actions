import * as builder from "~/builder.ts"
import { versionAsDev } from "~/util/shared.ts"

/**
 * Read the base extension version from src/description.xml and, when building
 * on the main branch, append the standard `-dev.<timestamp>+build.<n>` suffix.
 * On tag builds the literal description.xml version is returned (the tag is
 * authoritative elsewhere).
 */
export async function resolveExtensionVersion(): Promise<string> {
  const descText = await Deno.readTextFile("src/description.xml")
  const match = descText.match(/<version[^>]*\bvalue\s*=\s*"([^"]+)"/)
  if (!match) {
    throw new Error(
      "Could not parse <version value=...> from src/description.xml",
    )
  }
  const baseVersion = match[1]

  if (builder.env.branch === "main") {
    return versionAsDev(
      baseVersion,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
  }
  return baseVersion
}
