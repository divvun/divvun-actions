// deno-lint-ignore-file no-explicit-any

import logger from "~/util/log.ts"
import { Bash, versionAsNightly } from "~/util/shared.ts"

async function getXcodeMarketingVersion(input: string | null) {
  let cwd

  if (input != null && input !== "true") {
    cwd = input.trim()
  }
  // Xcode is the worst and I want out of this dastardly life.
  const [out] = await Bash.runScript(
    `xcodebuild -showBuildSettings | grep -i 'MARKETING_VERSION' | sed 's/[ ]*MARKETING_VERSION = //'`,
    { cwd },
  )
  return out.trim()
}

export type Props = {
  isXcode?: string | null
  isNightly?: boolean
  cargoToml: any
  spellerManifest?: any
  plistPath?: string | null
  csharp?: string | null
  versionFromFile?: string | null
  instaStable?: boolean
}

export const NIGHTLY_CHANNEL = "nightly"

export type Output = {
  version: string
  channel: string | null
}

export default async function version({
  isXcode,
  isNightly = false,
  cargoToml,
  spellerManifest = null,
  plistPath,
  csharp,
  versionFromFile,
  instaStable = false,
}: Props) {
  let version

  let channel: string | null = null

  if (cargoToml != null) {
    logger.debug("Getting version from TOML")
    version = cargoToml.package.version
  } else if (csharp != null) {
    logger.debug("Getting version from GitVersioning C#")
    version = Deno.env.get("GitBuildVersionSimple")
  } else if (spellerManifest != null) {
    logger.debug("Getting version from speller manifest")
    logger.debug(`spellerversion: ${spellerManifest.package.speller.version}`)
    version = spellerManifest.package.speller.version
  } else if (plistPath != null) {
    logger.debug("Getting version from plist")
    const result = (
      await Bash.runScript(
        `/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "${plistPath}"`,
      )
    )
      .join("")
      .trim()
    if (result === "") {
      throw new Error("No version found in plist")
    }
    version = result
  } else if (isXcode) {
    version = await getXcodeMarketingVersion(isXcode)
  } else if (versionFromFile != null) {
    version = versionFromFile
  } else {
    throw new Error("Did not find a suitable mechanism to derive the version.")
  }

  if (version == null || version.trim() === "") {
    throw new Error("Did not find any version.")
  }

  if (isNightly) {
    logger.debug(`Generating nightly version for channel ${NIGHTLY_CHANNEL}`)
    version = await versionAsNightly(version)

    // await builder.setOutput("channel", nightlyChannel)
    channel = NIGHTLY_CHANNEL
  } else {
    if (!instaStable) {
      // await builder.setOutput("channel", "beta")
      channel = "beta"
    } else {
      // An insta-stable package that is pre-1.0.0 will still be released to beta
      if (version.startsWith("0")) {
        // await builder.setOutput("channel", "beta")
        channel = "beta"
      }
    }
  }

  logger.debug("Setting version to: " + version)
  // await builder.setOutput("version", version)

  return { channel, version }
}
