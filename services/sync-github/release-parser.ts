import * as semver from "@std/semver"
import type { GithubRelease, PackageChannels } from "./types.ts"

function isStableVersion(version: string): boolean {
  try {
    const parsed = semver.parse(version)
    return parsed.major >= 1
  } catch {
    return false
  }
}

export function parseReleasesByPackage(
  releases: GithubRelease[],
): Record<string, PackageChannels> {
  const packages: Record<string, PackageChannels> = {}

  for (const release of releases) {
    // Handle dev-latest releases specially - extract version from release name
    if (release.tag_name.includes("dev-latest")) {
      // Release name format: "grammar-sma/v0.1.2-dev.20250111T123456Z+build.123"
      const nameMatch = release.name.match(/^(.+)\/v(.+)$/)
      if (nameMatch) {
        const packageName = nameMatch[1]
        const version = nameMatch[2]

        if (!packages[packageName]) {
          packages[packageName] = {}
        }

        const pkg = packages[packageName]
        if (!pkg.dev) {
          pkg.dev = version
        }
      }
      continue
    }

    const match = release.tag_name.match(/^(.+)\/v(.+)$/)

    if (!match) {
      continue
    }

    const packageName = match[1]
    const version = match[2]

    if (!packages[packageName]) {
      packages[packageName] = {}
    }

    const pkg = packages[packageName]

    if (release.prerelease && !pkg.beta) {
      pkg.beta = version
    } else if (!release.draft && !release.prerelease && !pkg.stable) {
      if (isStableVersion(version)) {
        pkg.stable = version
      } else if (!pkg.beta) {
        pkg.beta = version
      }
    }
  }

  return packages
}
