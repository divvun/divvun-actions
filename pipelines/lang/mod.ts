import * as fs from "@std/fs"
import * as path from "@std/path"
import * as semver from "@std/semver"
import * as toml from "@std/toml"
import * as yaml from "@std/yaml"
import proofingBundle, {
  type ProofingTarget,
} from "~/actions/proofing/bundle.ts"
import langProofingBuild from "~/actions/lang/build-proofing.ts"
import {
  proofingArtifact,
  proofingLocales,
  proofingPackage,
  proofingSource,
} from "~/actions/proofing/source.ts"
import langAnalyserBuild, {
  ANALYSER_DRB,
  ANALYSER_FST_BUNDLE,
} from "~/actions/lang/build-analyser.ts"
import langGrammarBuild from "~/actions/lang/build-grammar.ts"
import { runLangDocsPublish } from "~/actions/lang/docs-publish.ts"
import langSpellerBuild, {
  DESKTOP_ZHFST,
  MOBILE_ZHFST,
} from "~/actions/lang/build-speller.ts"
import langTeakstaBundleBuild from "~/actions/lang/build-teaksta-bundle.ts"
import langTtsTextprocBuild from "~/actions/lang/build-tts-textproc.ts"
import langCheck from "~/actions/lang/check.ts"
import { langDeps, usesRustToolchain } from "~/actions/lang/common.ts"
import langGrammarTest from "~/actions/lang/test-grammar.ts"
import langSpellerTest from "~/actions/lang/test-speller.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { downloadCompressedArtifacts } from "~/util/compressed_artifact.ts"
import { globFiles, globOneFile } from "~/util/glob.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums, release } from "~/util/hash.ts"
import { versionAsDev } from "~/util/shared.ts"
import spellerBundle from "../../actions/speller/bundle.ts"
import spellerDeploy from "../../actions/speller/deploy.ts"
import {
  deriveLangTag,
  SpellerManifest,
  SpellerType,
} from "../../actions/speller/manifest.ts"
import { NIGHTLY_CHANNEL } from "../../actions/version.ts"
import logger from "../../util/log.ts"

export { runLangDocsPublish }

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export type BuildProps = {
  "requires-desktop-as-mobile-workaround": boolean
  "fst": string[]
  "generators": boolean
  "spellers": boolean
  "hyphenators": boolean
  "analysers": boolean
  "grammar-checkers": boolean
  "tts-textproc": boolean
  /**
   * Build the teaksta (Konteaksta) divvun-runtime bundle from
   * `tools/teaksta/`. Implies `grammar-checkers`: the bundle's tokeniser,
   * whitespace analyser and mwe-dis come out of the grammar checker's .zcheck.
   */
  "teaksta-bundle": boolean
  "hyperminimalisation": boolean
  "reversed-intersect": boolean
  "two-step-intersect": boolean
  "speller-optimisation": boolean
  "backend-format": string | null
  "minimised-spellers": boolean
  "force-all-tools": boolean
}

const SPELLER_RELEASE_TAG = /^speller-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/
const GRAMMAR_RELEASE_TAG = /^grammar-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/
const TTS_TEXTPROC_RELEASE_TAG = /^tts-textproc-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/
const TEAKSTA_RELEASE_TAG = /^teaksta-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/
const PROOFING_RELEASE_TAG = /^x-proofing-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/
const ANALYSER_RELEASE_TAG = /^analyser-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/

/** Repos whose spellers get a GitHub release but never go to pahkat. */
const PAHKAT_EXCLUDED_SUFFIXES = ["-x-private", "-x-sensitive"]

/** Why a repo's spellers stay off pahkat, or null if they should publish. */
export function pahkatSkipReason(
  repoName: string,
  buildConfig: BuildProps | undefined,
  isPrivate: boolean,
): string | null {
  if (buildConfig?.spellers !== true) {
    return "build.spellers is not true in .build-config.yml"
  }
  const suffix = PAHKAT_EXCLUDED_SUFFIXES.find((s) => repoName.endsWith(s))
  if (suffix) {
    return `repo name ends in ${suffix}`
  }
  if (isPrivate) {
    return "repo is private"
  }
  return null
}

/**
 * `pahkatSkipReason` for this build. The GitHub lookup only runs once the
 * config and name checks pass, and throws rather than guessing on failure.
 */
async function pahkatSkipReasonForBuild(gh: GitHub): Promise<string | null> {
  const config = yaml.parse(await Deno.readTextFile(".build-config.yml")) as {
    build?: BuildProps
  } | null
  const repoName = builder.env.repoName
  return pahkatSkipReason(repoName, config?.build, false) ??
    pahkatSkipReason(repoName, config?.build, await gh.isPrivate())
}

function isConfigActive(config: BuildProps | undefined | null): boolean {
  if (!config) return false
  return Object.entries(config).some(([_key, value]) => {
    if (typeof value === "boolean") return value === true
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "string") return value.length > 0
    return false
  })
}

export async function runLangDeps() {
  await langDeps()
}

export async function runLangTest() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const checkConfig = config?.check as BuildProps | undefined

  const shouldCheck = isConfigActive(checkConfig)

  if (!shouldCheck) {
    logger.info(
      "No check configuration found in .build-config.yml, skipping tests",
    )
    return
  }

  await langCheck()
}

export async function runLangSpellerBuild() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const buildConfig = config?.build as BuildProps | undefined

  const shouldBuild = isConfigActive(buildConfig)

  if (!shouldBuild) {
    throw new Error(
      "No build configuration found in .build-config.yml",
    )
  }

  await langSpellerBuild(buildConfig!)
}

export async function runLangGrammarBuild() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const buildConfig = config?.build as BuildProps | undefined

  const shouldBuild = isConfigActive(buildConfig)

  if (!shouldBuild) {
    throw new Error(
      "No build configuration found in .build-config.yml",
    )
  }

  await langGrammarBuild(buildConfig!)
}

export async function runLangTtsTextprocBuild() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const buildConfig = config?.build as BuildProps | undefined

  const shouldBuild = isConfigActive(buildConfig)

  if (!shouldBuild) {
    throw new Error(
      "No build configuration found in .build-config.yml",
    )
  }

  await langTtsTextprocBuild(buildConfig!)
}

export async function runLangAnalyserBuild() {
  await langAnalyserBuild()
}

export async function runLangTeakstaBundleBuild() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const buildConfig = config?.build as BuildProps | undefined

  const shouldBuild = isConfigActive(buildConfig)

  if (!shouldBuild) {
    throw new Error(
      "No build configuration found in .build-config.yml",
    )
  }

  await langTeakstaBundleBuild(buildConfig!)
}

export async function runLangSpellerTest() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const checkConfig = config?.check as BuildProps | undefined

  const shouldCheck = isConfigActive(checkConfig)

  if (!shouldCheck) {
    logger.info(
      "No check configuration found in .build-config.yml, skipping tests",
    )
    return
  }

  await langSpellerTest()
}

export async function runLangGrammarTest() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const checkConfig = config?.check as BuildProps | undefined

  const shouldCheck = isConfigActive(checkConfig)

  if (!shouldCheck) {
    logger.info(
      "No check configuration found in .build-config.yml, skipping tests",
    )
    return
  }

  await langGrammarTest()
}

export async function runLangBundle(
  { target }: { target: "windows" | "macos" | "mobile" },
) {
  // Each installer packs only its own variant.
  await builder.downloadArtifacts(
    target === "mobile" ? MOBILE_ZHFST : DESKTOP_ZHFST,
    ".",
  )

  const spellerPaths = JSON.parse(await builder.metadata("speller-paths"))
  let manifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as SpellerManifest
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  let spellerType: SpellerType

  switch (target) {
    case "windows":
      spellerType = SpellerType.Windows
      break
    case "macos":
      spellerType = SpellerType.MacOS
      break
    case "mobile":
      spellerType = SpellerType.Mobile
      break
  }

  await spellerBundle({
    spellerType,
    manifest,
    spellerPaths,
  })
}

/**
 * Download each desktop .zhfst (the hfst-ospell speller, for CKospell and the
 * like) and rename it `<package>_<version>_noarch-desktop-<tag>.zhfst` for the
 * release.
 */
async function versionedDesktopZhfsts(
  packageName: string,
  version: string,
): Promise<string[]> {
  await builder.downloadArtifacts(DESKTOP_ZHFST, ".")
  const spellerPaths = JSON.parse(await builder.metadata("speller-paths")) as {
    desktop: Record<string, string>
  }
  const out: string[] = []
  for (const [tag, file] of Object.entries(spellerPaths.desktop)) {
    const versioned = `${packageName}_${version}_noarch-desktop-${tag}.zhfst`
    await Deno.rename(file, versioned)
    out.push(versioned)
  }
  if (out.length === 0) {
    throw new Error("No desktop .zhfst in the speller-paths metadata")
  }
  return out
}

function extractVersionFromTag(tag: string): string | null {
  const match = tag.match(/\/v(\d+\.\d+\.\d+(?:-\S+)?)$/)
  return match ? match[1] : null
}

function isPrerelease(version: string): boolean {
  try {
    const parsed = semver.parse(version)
    return parsed.major === 0 || (parsed.prerelease?.length ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * The speller's outto installers, as spellerBundle uploads them. The proofing
 * installers of the same build are also outto installers, so these name the
 * speller's.
 */
const SPELLER_WINDOWS_ARTIFACT = "speller-*_noarch-windows*.exe"
const SPELLER_MACOS_ARTIFACT = "speller-*_noarch-macos.app.zip"

export async function runLangDeploy() {
  const isSpellerReleaseTag = SPELLER_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  let manifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as SpellerManifest
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  await builder.downloadArtifacts("*.pkt.tar.zst", ".")
  await builder.downloadArtifacts(SPELLER_WINDOWS_ARTIFACT, ".")
  await builder.downloadArtifacts(SPELLER_MACOS_ARTIFACT, ".")

  const windowsFiles = await globOneFile(SPELLER_WINDOWS_ARTIFACT)
  const macosFiles = await globOneFile(SPELLER_MACOS_ARTIFACT)
  const mobileFiles = await globOneFile("*-mobile.pkt.tar.zst")

  logger.info("Deploying language files:")
  logger.info(`- Windows: ${windowsFiles}`)
  logger.info(`- macOS: ${macosFiles}`)
  logger.info(`- Mobile: ${mobileFiles}`)

  if (!windowsFiles || !macosFiles || !mobileFiles) {
    throw new Error("Missing required files for deployment")
  }

  if (isSpellerReleaseTag) {
    if (!builder.env.repo) {
      throw new Error("No repository information available")
    }

    if (!builder.env.tag) {
      throw new Error("No tag information available")
    }

    const tagVersion = extractVersionFromTag(builder.env.tag)
    if (!tagVersion) {
      throw new Error(`Could not extract version from tag: ${builder.env.tag}`)
    }

    const prerelease = isPrerelease(tagVersion)

    const versionWithBuild = builder.env.buildNumber
      ? `${tagVersion}+build.${builder.env.buildNumber}`
      : tagVersion

    const langMatch = builder.env.repoName?.match(/lang-(.+)/)
    if (!langMatch) {
      throw new Error(
        `Could not extract language code from repo: ${builder.env.repoName}`,
      )
    }
    const langCode = langMatch[1]
    const packageName = `speller-${langCode}`

    const versionedWindowsFile =
      `${packageName}_${versionWithBuild}_noarch-windows.exe`
    const versionedMacosFile =
      `${packageName}_${versionWithBuild}_noarch-macos.app.zip`
    const versionedMobileFile =
      `${packageName}_${versionWithBuild}_noarch-mobile.pkt.tar.zst`

    await Deno.rename(windowsFiles, versionedWindowsFile)
    await Deno.rename(macosFiles, versionedMacosFile)
    await Deno.rename(mobileFiles, versionedMobileFile)

    const artifacts = [
      versionedWindowsFile,
      versionedMacosFile,
      versionedMobileFile,
      ...await versionedDesktopZhfsts(packageName, versionWithBuild),
    ]
    const allSecrets = await builder.secrets(
      "s3/accessKeyId",
      "s3/secretAccessKey",
      "pahkat/apiKey",
    )
    const gh = new GitHub(builder.env.repo)
    const pahkatSkip = await pahkatSkipReasonForBuild(gh)
    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.ciKey(),
      release(builder.env, {
        tag: builder.env.tag,
        version: versionWithBuild,
        package: pahkatSkip ? undefined : `main/${packageName}`,
      }),
    )

    logger.info(`Creating GitHub release for speller version ${tagVersion}`)
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifacts: ${artifacts.join(", ")}`)

    await gh.createRelease(
      builder.env.tag,
      [...artifacts, checksumFile, signatureFile],
      { prerelease },
    )

    logger.info("Speller GitHub release created successfully")

    if (pahkatSkip) {
      logger.info(
        `Skipping pahkat publish for ${builder.env.repoName}: ${pahkatSkip}`,
      )
      return
    }

    const pahkatSecrets = {
      awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
      awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
      pahkatApiKey: allSecrets.get("pahkat/apiKey"),
    }

    logger.info("Publishing speller to pahkat")
    await spellerDeploy({
      spellerType: SpellerType.Windows,
      manifestPath: "./manifest.toml",
      payloadPath: versionedWindowsFile,
      version: versionWithBuild,
      channel: null,
      pahkatRepo: "https://pahkat.uit.no/main/",
      secrets: pahkatSecrets,
    })
    await spellerDeploy({
      spellerType: SpellerType.MacOS,
      manifestPath: "./manifest.toml",
      payloadPath: versionedMacosFile,
      version: versionWithBuild,
      channel: null,
      pahkatRepo: "https://pahkat.uit.no/main/",
      secrets: pahkatSecrets,
    })
    await spellerDeploy({
      spellerType: SpellerType.Mobile,
      manifestPath: "./manifest.toml",
      payloadPath: versionedMobileFile,
      version: versionWithBuild,
      channel: null,
      pahkatRepo: "https://pahkat.uit.no/main/",
      secrets: pahkatSecrets,
    })
    logger.info("Speller pahkat publish completed for all platforms")
  } else if (isMainBranch) {
    if (!builder.env.repo) {
      throw new Error("No repository information available")
    }

    const devVersion = versionAsDev(
      manifest.package.speller.version,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )

    const langMatch = builder.env.repoName?.match(/lang-(.+)/)
    if (!langMatch) {
      throw new Error(
        `Could not extract language code from repo: ${builder.env.repoName}`,
      )
    }
    const langCode = langMatch[1]
    const packageName = `speller-${langCode}`
    const releaseTag = `speller-${langCode}/dev-latest`

    const versionedWindowsFile =
      `${packageName}_${devVersion}_noarch-windows.exe`
    const versionedMacosFile =
      `${packageName}_${devVersion}_noarch-macos.app.zip`
    const versionedMobileFile =
      `${packageName}_${devVersion}_noarch-mobile.pkt.tar.zst`

    await Deno.rename(windowsFiles, versionedWindowsFile)
    await Deno.rename(macosFiles, versionedMacosFile)
    await Deno.rename(mobileFiles, versionedMobileFile)

    const artifacts = [
      versionedWindowsFile,
      versionedMacosFile,
      versionedMobileFile,
      ...await versionedDesktopZhfsts(packageName, devVersion),
    ]
    const allSecrets = await builder.secrets(
      "s3/accessKeyId",
      "s3/secretAccessKey",
      "pahkat/apiKey",
    )
    const gh = new GitHub(builder.env.repo)
    const pahkatSkip = await pahkatSkipReasonForBuild(gh)
    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.ciKey(),
      release(builder.env, {
        tag: releaseTag,
        version: devVersion,
        package: pahkatSkip ? undefined : `main/${packageName}`,
      }),
    )

    logger.info(
      `Creating dev-latest GitHub release for speller version ${devVersion}`,
    )
    logger.info(`Release tag: ${releaseTag}`)
    logger.info(`Artifacts: ${artifacts.join(", ")}`)

    const releaseName = `${packageName}/v${devVersion}`
    await gh.updateRelease(
      releaseTag,
      [...artifacts, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: releaseName },
    )

    logger.info("Speller dev-latest GitHub release updated successfully")

    if (pahkatSkip) {
      logger.info(
        `Skipping pahkat publish for ${builder.env.repoName}: ${pahkatSkip}`,
      )
      return
    }

    const pahkatSecrets = {
      awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
      awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
      pahkatApiKey: allSecrets.get("pahkat/apiKey"),
    }

    // builder.env.repo is the clone URL (git@github.com:owner/repo.git for
    // sync-managed pipelines, https://…/owner/repo.git otherwise); the asset URL
    // needs the bare owner/repo, which env.repoPath already normalises.
    const githubAssetUrl = (filename: string) =>
      `https://github.com/${builder.env.repoPath}/releases/download/${releaseTag}/${filename}`

    logger.info(
      "Publishing nightly speller to pahkat (GitHub-hosted artifacts)",
    )
    await spellerDeploy({
      spellerType: SpellerType.Windows,
      manifestPath: "./manifest.toml",
      payloadPath: versionedWindowsFile,
      version: devVersion,
      channel: NIGHTLY_CHANNEL,
      pahkatRepo: "https://pahkat.uit.no/main/",
      artifactUrl: githubAssetUrl(versionedWindowsFile),
      secrets: pahkatSecrets,
    })
    await spellerDeploy({
      spellerType: SpellerType.MacOS,
      manifestPath: "./manifest.toml",
      payloadPath: versionedMacosFile,
      version: devVersion,
      channel: NIGHTLY_CHANNEL,
      pahkatRepo: "https://pahkat.uit.no/main/",
      artifactUrl: githubAssetUrl(versionedMacosFile),
      secrets: pahkatSecrets,
    })
    await spellerDeploy({
      spellerType: SpellerType.Mobile,
      manifestPath: "./manifest.toml",
      payloadPath: versionedMobileFile,
      version: devVersion,
      channel: NIGHTLY_CHANNEL,
      pahkatRepo: "https://pahkat.uit.no/main/",
      artifactUrl: githubAssetUrl(versionedMobileFile),
      secrets: pahkatSecrets,
    })
    logger.info("Nightly speller pahkat publish completed for all platforms")
  }
}

/**
 * The grammar-build step's outputs. Only this directory: a bare `*.drb` would
 * also fetch the TTS, teaksta and proofing bundles.
 */
const GRAMMAR_DRB = "build/tools/grammarcheckers/*.drb"
const GRAMMAR_ZCHECK = "build/tools/grammarcheckers/*.zcheck"

export async function runLangGrammarDeploy() {
  const isGrammarReleaseTag = GRAMMAR_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  await downloadCompressedArtifacts(GRAMMAR_DRB)
  await downloadCompressedArtifacts(GRAMMAR_ZCHECK)

  const drbFiles = await globFiles(GRAMMAR_DRB)
  const zcheckFiles = await globFiles(GRAMMAR_ZCHECK)

  if (drbFiles.length === 0) {
    throw new Error("Missing .drb file for deployment")
  }

  if (zcheckFiles.length === 0) {
    throw new Error("Missing .zcheck file for deployment")
  }

  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  let manifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as any
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  const langTag = builder.env.repoName.split("lang-")[1]?.split("-")[0] ||
    "unknown"

  const drbFile = drbFiles[0]
  const zcheckFile = zcheckFiles[0]

  if (isGrammarReleaseTag) {
    if (!builder.env.tag) {
      throw new Error("No tag information available")
    }

    const tagVersion = extractVersionFromTag(builder.env.tag)
    if (!tagVersion) {
      throw new Error(`Could not extract version from tag: ${builder.env.tag}`)
    }

    const prerelease = isPrerelease(tagVersion)

    const versionWithBuild = builder.env.buildNumber
      ? `${tagVersion}+build.${builder.env.buildNumber}`
      : tagVersion

    const packageName = `grammar-${langTag}`

    const versionedDrbFile = `${packageName}_${versionWithBuild}_noarch-all.drb`
    const versionedZcheckFile =
      `${packageName}_${versionWithBuild}_noarch-all.zcheck`

    await Deno.rename(drbFile, versionedDrbFile)
    await Deno.rename(zcheckFile, versionedZcheckFile)

    const artifacts = [versionedDrbFile, versionedZcheckFile]
    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.ciKey(),
      release(builder.env, { tag: builder.env.tag, version: versionWithBuild }),
    )

    logger.info(`Creating GitHub release for grammar version ${tagVersion}`)
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifacts: ${artifacts.join(", ")}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [...artifacts, checksumFile, signatureFile],
      { prerelease },
    )

    logger.info("Grammar checker GitHub release created successfully")
  } else if (isMainBranch) {
    const devVersion = versionAsDev(
      manifest.package.grammar.version,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )

    const packageName = `grammar-${langTag}`
    const releaseTag = `grammar-${langTag}/dev-latest`

    const versionedDrbFile = `${packageName}_${devVersion}_noarch-all.drb`
    const versionedZcheckFile = `${packageName}_${devVersion}_noarch-all.zcheck`

    await Deno.rename(drbFile, versionedDrbFile)
    await Deno.rename(zcheckFile, versionedZcheckFile)

    const artifacts = [versionedDrbFile, versionedZcheckFile]
    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.ciKey(),
      release(builder.env, { tag: releaseTag, version: devVersion }),
    )

    logger.info(
      `Creating dev-latest GitHub release for grammar version ${devVersion}`,
    )
    logger.info(`Release tag: ${releaseTag}`)
    logger.info(`Artifacts: ${artifacts.join(", ")}`)

    const releaseName = `${packageName}/v${devVersion}`
    const gh = new GitHub(builder.env.repo)
    await gh.updateRelease(
      releaseTag,
      [...artifacts, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: releaseName },
    )

    logger.info(
      "Grammar checker dev-latest GitHub release updated successfully",
    )
  }
}

async function readProofingSource() {
  const config = yaml.parse(await Deno.readTextFile(".build-config.yml")) as {
    build?: BuildProps
  }
  const source = proofingSource(config?.build)
  if (!source) {
    throw new Error(
      "Proofing requires spellers or grammar-checkers to be enabled",
    )
  }
  return source
}

export async function runLangProofingBuild() {
  const source = await readProofingSource()
  if (source !== "speller") {
    throw new Error(
      "Grammar-enabled proofing must use the grammar-build artifact",
    )
  }
  const manifest = toml.parse(
    await Deno.readTextFile("manifest.toml"),
  ) as SpellerManifest
  await langProofingBuild({
    ...proofingPackage(source, manifest),
    locales: proofingLocales(manifest),
  })
}

export async function runLangProofingBundle(
  { target }: { target: ProofingTarget },
) {
  const source = await readProofingSource()
  const artifact = proofingArtifact(source)
  await downloadCompressedArtifacts(artifact)

  const drbFiles = await globFiles(artifact)
  if (drbFiles.length !== 1) {
    throw new Error(
      `Expected one ${source} .drb file for proofing, found ${drbFiles.length}`,
    )
  }

  let manifest: SpellerManifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as SpellerManifest
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  const langTag = deriveLangTag()
  const packageId = `x-proofing-${langTag}`
  const info = proofingPackage(source, manifest, langTag)
  const baseVersion = info.version

  const isProofingReleaseTag = PROOFING_RELEASE_TAG.test(builder.env.tag ?? "")
  const tagVersion = builder.env.tag
    ? extractVersionFromTag(builder.env.tag)
    : null
  const version = isProofingReleaseTag && tagVersion
    ? tagVersion
    : versionAsDev(
      baseVersion,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )

  await proofingBundle({
    target,
    packageId,
    langTag,
    name: `${info.name} (proofing)`,
    version,
    buildNumber: parseInt(builder.env.buildNumber ?? "1"),
    drbPath: drbFiles[0],
  })
}

export async function runLangProofingDeploy() {
  const isProofingReleaseTag = PROOFING_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  await builder.downloadArtifacts("x-proofing-*_noarch-macos.app.zip", ".")
  await builder.downloadArtifacts("x-proofing-*_noarch-windows*.exe", ".")
  await builder.downloadArtifacts("x-proofing-*_noarch-linux.pkt.tar.zst", ".")

  const macosFile = await globOneFile("x-proofing-*_noarch-macos.app.zip")
  const windowsFile = await globOneFile("x-proofing-*_noarch-windows*.exe")
  const linuxFile = await globOneFile("x-proofing-*_noarch-linux.pkt.tar.zst")

  logger.info("Deploying proofing packages:")
  logger.info(`- macOS: ${macosFile}`)
  logger.info(`- Windows: ${windowsFile}`)
  logger.info(`- Linux: ${linuxFile}`)

  if (!macosFile || !windowsFile || !linuxFile) {
    throw new Error("Missing required proofing artifacts for deployment")
  }

  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  let manifest: SpellerManifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as SpellerManifest
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  const langTag = deriveLangTag()
  const packageName = `x-proofing-${langTag}`
  const artifacts = [macosFile, windowsFile, linuxFile].map((file) =>
    path.basename(file)
  )

  if (isProofingReleaseTag) {
    if (!builder.env.tag) {
      throw new Error("No tag information available")
    }
    const tagVersion = extractVersionFromTag(builder.env.tag)
    if (!tagVersion) {
      throw new Error(`Could not extract version from tag: ${builder.env.tag}`)
    }
    const prerelease = isPrerelease(tagVersion)

    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.ciKey(),
      release(builder.env, { tag: builder.env.tag, version: tagVersion }),
    )

    logger.info(`Creating GitHub release for proofing version ${tagVersion}`)
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifacts: ${artifacts.join(", ")}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [...artifacts, checksumFile, signatureFile],
      { prerelease },
    )
    logger.info("Proofing GitHub release created successfully")
  } else if (isMainBranch) {
    const devVersion = versionAsDev(
      proofingPackage(await readProofingSource(), manifest).version,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
    const releaseTag = `x-proofing-${langTag}/dev-latest`

    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.ciKey(),
      release(builder.env, { tag: releaseTag, version: devVersion }),
    )

    logger.info(
      `Creating dev-latest GitHub release for proofing version ${devVersion}`,
    )
    logger.info(`Release tag: ${releaseTag}`)
    logger.info(`Artifacts: ${artifacts.join(", ")}`)

    const releaseName = `${packageName}/v${devVersion}`
    const gh = new GitHub(builder.env.repo)
    await gh.updateRelease(
      releaseTag,
      [...artifacts, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: releaseName },
    )
    logger.info("Proofing dev-latest GitHub release updated successfully")
  }
}

export async function runLangTtsTextprocDeploy() {
  const isTtsReleaseTag = TTS_TEXTPROC_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  const bundlePath = "build/tools/tts/bundle.drb"
  await downloadCompressedArtifacts(bundlePath)
  if (!await fs.exists(bundlePath)) {
    throw new Error("TTS bundle.drb not found for deployment")
  }

  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  let manifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as any
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  const langMatch = builder.env.repoName?.match(/lang-(.+)/)
  if (!langMatch) {
    throw new Error(
      `Could not extract language code from repo: ${builder.env.repoName}`,
    )
  }
  const langCode = langMatch[1]
  const packageName = `tts-textproc-${langCode}`

  if (isTtsReleaseTag) {
    if (!builder.env.tag) {
      throw new Error("No tag information available")
    }

    const tagVersion = extractVersionFromTag(builder.env.tag)
    if (!tagVersion) {
      throw new Error(`Could not extract version from tag: ${builder.env.tag}`)
    }

    const prerelease = isPrerelease(tagVersion)

    const versionWithBuild = builder.env.buildNumber
      ? `${tagVersion}+build.${builder.env.buildNumber}`
      : tagVersion

    const versionedFile = `${packageName}_${versionWithBuild}_noarch-all.drb`
    await Deno.rename(bundlePath, versionedFile)

    const { checksumFile, signatureFile } = await createSignedChecksums(
      [versionedFile],
      await builder.ciKey(),
      release(builder.env, { tag: builder.env.tag, version: versionWithBuild }),
    )

    logger.info(
      `Creating GitHub release for TTS text processor version ${tagVersion}`,
    )
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifact: ${versionedFile}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [versionedFile, checksumFile, signatureFile],
      { prerelease },
    )

    logger.info("TTS text processor GitHub release created successfully")
  } else if (isMainBranch) {
    const devVersion = versionAsDev(
      manifest.package["tts-textproc"]?.version ??
        manifest.package.speller.version,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )

    const releaseTag = `tts-textproc-${langCode}/dev-latest`

    const versionedFile = `${packageName}_${devVersion}_noarch-all.drb`
    await Deno.rename(bundlePath, versionedFile)

    const { checksumFile, signatureFile } = await createSignedChecksums(
      [versionedFile],
      await builder.ciKey(),
      release(builder.env, { tag: releaseTag, version: devVersion }),
    )

    logger.info(
      `Creating dev-latest GitHub release for TTS text processor version ${devVersion}`,
    )
    logger.info(`Release tag: ${releaseTag}`)
    logger.info(`Artifact: ${versionedFile}`)

    const releaseName = `${packageName}/v${devVersion}`
    const gh = new GitHub(builder.env.repo)
    await gh.updateRelease(
      releaseTag,
      [versionedFile, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: releaseName },
    )

    logger.info(
      "TTS text processor dev-latest GitHub release updated successfully",
    )
  }
}

export async function runLangTeakstaBundleDeploy() {
  const isTeakstaReleaseTag = TEAKSTA_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  const bundlePath = "tools/teaksta/bundle.drb"
  await downloadCompressedArtifacts(bundlePath)

  if (!await fs.exists(bundlePath)) {
    throw new Error("teaksta bundle.drb not found for deployment")
  }

  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  let manifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as any
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  const langMatch = builder.env.repoName?.match(/lang-(.+)/)
  if (!langMatch) {
    throw new Error(
      `Could not extract language code from repo: ${builder.env.repoName}`,
    )
  }
  const langCode = langMatch[1]
  const packageName = `teaksta-${langCode}`

  if (isTeakstaReleaseTag) {
    if (!builder.env.tag) {
      throw new Error("No tag information available")
    }

    const tagVersion = extractVersionFromTag(builder.env.tag)
    if (!tagVersion) {
      throw new Error(`Could not extract version from tag: ${builder.env.tag}`)
    }

    const prerelease = isPrerelease(tagVersion)

    const versionWithBuild = builder.env.buildNumber
      ? `${tagVersion}+build.${builder.env.buildNumber}`
      : tagVersion

    const versionedFile = `${packageName}_${versionWithBuild}_noarch-all.drb`
    await Deno.rename(bundlePath, versionedFile)

    const { checksumFile, signatureFile } = await createSignedChecksums(
      [versionedFile],
      await builder.ciKey(),
      release(builder.env, { tag: builder.env.tag, version: versionWithBuild }),
    )

    logger.info(`Creating GitHub release for teaksta bundle ${tagVersion}`)
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifact: ${versionedFile}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [versionedFile, checksumFile, signatureFile],
      { prerelease },
    )

    logger.info("teaksta bundle GitHub release created successfully")
  } else if (isMainBranch) {
    // The bundle is assembled from the grammar checker's models, so it tracks
    // the grammar version where one is declared.
    const devVersion = versionAsDev(
      manifest.package["teaksta-bundle"]?.version ??
        manifest.package.grammar?.version ??
        manifest.package.speller.version,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )

    const releaseTag = `${packageName}/dev-latest`

    const versionedFile = `${packageName}_${devVersion}_noarch-all.drb`
    await Deno.rename(bundlePath, versionedFile)

    const { checksumFile, signatureFile } = await createSignedChecksums(
      [versionedFile],
      await builder.ciKey(),
      release(builder.env, { tag: releaseTag, version: devVersion }),
    )

    logger.info(
      `Creating dev-latest GitHub release for teaksta bundle ${devVersion}`,
    )
    logger.info(`Release tag: ${releaseTag}`)
    logger.info(`Artifact: ${versionedFile}`)

    const releaseName = `${packageName}/v${devVersion}`
    const gh = new GitHub(builder.env.repo)
    await gh.updateRelease(
      releaseTag,
      [versionedFile, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: releaseName },
    )

    logger.info("teaksta bundle dev-latest GitHub release updated successfully")
  }
}

/**
 * The analysers, generators and analyser `bundle.drb` as their own release,
 * `analyser-<lang>/vX.Y.Z` or `analyser-<lang>/dev-latest` from main.
 */
export async function runLangAnalyserDeploy() {
  const tag = builder.env.tag
  const isAnalyserReleaseTag = ANALYSER_RELEASE_TAG.test(tag ?? "")
  if (!isAnalyserReleaseTag && builder.env.branch !== "main") {
    logger.info("Not main or an analyser release tag; nothing to deploy")
    return
  }
  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  const langMatch = builder.env.repoName?.match(/lang-(.+)/)
  if (!langMatch) {
    throw new Error(
      `Could not extract language code from repo: ${builder.env.repoName}`,
    )
  }
  const packageName = `analyser-${langMatch[1]}`

  let version: string
  let prerelease = true
  if (isAnalyserReleaseTag) {
    const tagVersion = extractVersionFromTag(tag!)
    if (!tagVersion) {
      throw new Error(`Could not extract version from tag: ${tag}`)
    }
    prerelease = isPrerelease(tagVersion)
    version = builder.env.buildNumber
      ? `${tagVersion}+build.${builder.env.buildNumber}`
      : tagVersion
  } else {
    const manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as { package: Record<string, { version?: string } | undefined> }
    const baseVersion = manifest.package.analyser?.version ??
      manifest.package.speller?.version
    if (!baseVersion) {
      throw new Error(
        "manifest.toml has neither package.analyser.version nor " +
          "package.speller.version",
      )
    }
    version = versionAsDev(
      baseVersion,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )
  }

  await builder.downloadArtifacts(ANALYSER_FST_BUNDLE, ".")
  await downloadCompressedArtifacts(ANALYSER_DRB)
  for (const file of [ANALYSER_FST_BUNDLE, ANALYSER_DRB]) {
    if (!await fs.exists(file)) {
      throw new Error(`${file} not found for deployment`)
    }
  }

  const fstFile = `${packageName}_${version}_noarch-all.pkt.tar.zst`
  const drbFile = `${packageName}_${version}_noarch-all.drb`
  await Deno.rename(ANALYSER_FST_BUNDLE, fstFile)
  await Deno.rename(ANALYSER_DRB, drbFile)

  const releaseTag = isAnalyserReleaseTag ? tag! : `${packageName}/dev-latest`
  const artifacts = [fstFile, drbFile]
  const { checksumFile, signatureFile } = await createSignedChecksums(
    artifacts,
    await builder.ciKey(),
    release(builder.env, { tag: releaseTag, version }),
  )
  logger.info(`Artifacts: ${artifacts.join(", ")}`)

  const gh = new GitHub(builder.env.repo)
  if (isAnalyserReleaseTag) {
    logger.info(
      `Creating GitHub release ${releaseTag} (pre-release: ${prerelease})`,
    )
    await gh.createRelease(
      releaseTag,
      [...artifacts, checksumFile, signatureFile],
      { prerelease },
    )
  } else {
    logger.info(`Updating GitHub release ${releaseTag}`)
    await gh.updateRelease(
      releaseTag,
      [...artifacts, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: `${packageName}/v${version}` },
    )
  }
  logger.info("Analyser GitHub release published")
}

// Anything using more than like 20gb of RAM is considered large
const LARGE_BUILDS = [
  "lang-kal",
  "lang-sme",
]

export async function pipelineLang() {
  const isSpellerReleaseTag = SPELLER_RELEASE_TAG.test(builder.env.tag ?? "")
  const isGrammarReleaseTag = GRAMMAR_RELEASE_TAG.test(builder.env.tag ?? "")
  const isTtsTextprocReleaseTag = TTS_TEXTPROC_RELEASE_TAG.test(
    builder.env.tag ?? "",
  )
  const isTeakstaReleaseTag = TEAKSTA_RELEASE_TAG.test(builder.env.tag ?? "")
  const isProofingReleaseTag = PROOFING_RELEASE_TAG.test(builder.env.tag ?? "")
  const isAnalyserReleaseTag = ANALYSER_RELEASE_TAG.test(builder.env.tag ?? "")
  const isReleaseTag = isSpellerReleaseTag || isGrammarReleaseTag ||
    isTtsTextprocReleaseTag || isTeakstaReleaseTag || isProofingReleaseTag ||
    isAnalyserReleaseTag

  const extra: Record<string, string> =
    LARGE_BUILDS.includes(builder.env.repoName) ? { size: "large" } : {}

  // Steps that shell out to hfst/cg3 are tagged when a repo is opted back to
  // the C++ toolchain, so the exception is visible from the build page.
  // setupLangToolchain() does the actual PATH switch off the same
  // predicate.
  const toolchainTag = usesRustToolchain() ? "" : " (C++)"

  // Read build configuration to check if grammar-checkers are enabled
  let buildConfig: BuildProps | undefined
  try {
    const yml = await Deno.readTextFile(".build-config.yml")
    const config = await yaml.parse(yml) as any
    buildConfig = config?.build as BuildProps | undefined
  } catch {
    // Config file not found or invalid, buildConfig remains undefined
  }

  // Decides every dependency repo commit for the whole build, and builds
  // them once; every step that builds or tests unpacks its result.
  const depsStep = command({
    key: "lang-deps",
    label: "Fetch Dependencies",
    command: "divvun-actions run lang-deps",
    agents: {
      queue: "linux",
    },
  })

  // Separate build steps for spellers and grammar checkers
  const spellerBuildStep = command({
    key: "speller-build",
    label: `Build Spellers${toolchainTag}`,
    command: "divvun-actions run lang-speller-build",
    depends_on: "lang-deps",
    agents: {
      queue: "linux",
      ...extra,
    },
  })

  if (extra.size === "large") {
    spellerBuildStep.priority = 10
  }

  const grammarBuildStep = command({
    key: "grammar-build",
    label: `Build Grammar Checkers${toolchainTag}`,
    command: "divvun-actions run lang-grammar-build",
    depends_on: "speller-build",
    agents: {
      queue: "linux",
      ...extra,
    },
  })

  if (extra.size === "large") {
    grammarBuildStep.priority = 10
  }

  const ttsTextprocBuildStep = command({
    key: "tts-textproc-build",
    label: `Build TTS Text Processor${toolchainTag}`,
    command: "divvun-actions run lang-tts-textproc-build",
    depends_on: "lang-deps",
    agents: {
      queue: "linux",
      ...extra,
    },
  })

  if (extra.size === "large") {
    ttsTextprocBuildStep.priority = 10
  }

  const teakstaBundleBuildStep = command({
    key: "teaksta-bundle-build",
    label: `Build Teaksta Bundle${toolchainTag}`,
    command: "divvun-actions run lang-teaksta-bundle-build",
    // The tokeniser, whitespace analyser and mwe-dis come out of the grammar
    // checker's .zcheck; see actions/lang/build-teaksta-bundle.ts.
    depends_on: "grammar-build",
    agents: {
      queue: "linux",
      ...extra,
    },
  })

  if (extra.size === "large") {
    teakstaBundleBuildStep.priority = 10
  }

  // Builds from scratch beside speller-build, so it neither waits on it nor
  // needs spellers enabled.
  const analyserBuildStep = command({
    key: "analyser-build",
    label: `Build Analysers${toolchainTag}`,
    command: "divvun-actions run lang-analyser-build",
    depends_on: "lang-deps",
    agents: {
      queue: "linux",
      ...extra,
    },
  })

  if (extra.size === "large") {
    analyserBuildStep.priority = 10
  }

  // We only deploy on main branch or release tags. An analyser tag builds
  // nothing else, so nothing else may deploy from it.
  const isMainDeploy = builder.env.branch === "main" && !isAnalyserReleaseTag
  // Repos with spellers off have no speller to build, test or ship. The
  // grammar checker still builds on the speller workspace, so it keeps the
  // speller build (no repo has grammar checkers without spellers).
  const hasSpellerBuild = buildConfig?.spellers === true ||
    buildConfig?.["grammar-checkers"] === true
  const hasSpellers = buildConfig?.spellers === true
  const isSpellerDeploy = hasSpellers && (isSpellerReleaseTag || isMainDeploy)
  const isGrammarDeploy = isGrammarReleaseTag || isMainDeploy
  const isTtsTextprocDeploy = isTtsTextprocReleaseTag || isMainDeploy
  const isTeakstaDeploy = isTeakstaReleaseTag || builder.env.branch === "main"
  // Built only to be released, on main and its own release tags.
  const isAnalyserDeploy = buildConfig?.analysers === true &&
    (isAnalyserReleaseTag || (!isReleaseTag && builder.env.branch === "main"))
  // Proofing uses the combined grammar DRB when enabled, otherwise a spelling
  // pipeline built from the speller workspace. Other product tags never depend
  // on a proofing producer that their release build omitted.
  const proofing = proofingSource(buildConfig)
  const isProofingDeploy = isProofingReleaseTag ||
    (!isReleaseTag && builder.env.branch === "main")

  // Build phase steps array
  const buildSteps: CommandStep[] = []

  // Speller build is needed for everything except textproc-only and
  // analyser-only releases
  if (hasSpellerBuild && !isTtsTextprocReleaseTag && !isAnalyserReleaseTag) {
    buildSteps.push(spellerBuildStep)
  }

  if (
    buildConfig?.["grammar-checkers"] === true &&
    (isGrammarReleaseTag ||
      (!isSpellerReleaseTag && !isTtsTextprocReleaseTag &&
        !isAnalyserReleaseTag))
  ) {
    buildSteps.push(grammarBuildStep)
  }

  if (
    isTtsTextprocReleaseTag ||
    (buildConfig?.["tts-textproc"] === true && !isSpellerReleaseTag &&
      !isTeakstaReleaseTag && !isAnalyserReleaseTag)
  ) {
    buildSteps.push(ttsTextprocBuildStep)
  }

  if (isAnalyserDeploy) {
    buildSteps.push(analyserBuildStep)
  }

  // The teaksta bundle is assembled from the grammar checker's models, so it
  // can only be built where the grammar checkers are, and never on a release
  // tag that suppresses the speller/grammar chain it hangs off.
  const canBuildTeaksta = buildConfig?.["grammar-checkers"] === true &&
    !isSpellerReleaseTag && !isTtsTextprocReleaseTag && !isAnalyserReleaseTag

  if (
    canBuildTeaksta &&
    (isTeakstaReleaseTag || buildConfig?.["teaksta-bundle"] === true)
  ) {
    buildSteps.push(teakstaBundleBuildStep)
  }

  if (proofing === "speller" && isProofingDeploy) {
    buildSteps.push(command({
      key: "proofing-build",
      label: `Build Proofing (spelling only)${toolchainTag}`,
      command: "divvun-actions run lang-proofing-build",
      depends_on: "speller-build",
      soft_fail: true,
      agents: { queue: "linux", ...extra },
    }))
  }

  if (buildSteps.length > 0) {
    buildSteps.unshift(depsStep)
  }

  // Test phase steps array (only on non-release builds)
  const testSteps: CommandStep[] = []

  if (!isReleaseTag) {
    if (hasSpellerBuild) {
      testSteps.push(command({
        key: "speller-test",
        label: `Test Spellers${toolchainTag}`,
        command: "divvun-actions run lang-speller-test",
        depends_on: "speller-build",
        soft_fail: true,
        timeout_in_minutes: 60,
        agents: {
          queue: "linux",
          ...extra,
        },
      }))
    }

    if (
      buildConfig?.["grammar-checkers"] === true &&
      (isGrammarReleaseTag || !isSpellerReleaseTag)
    ) {
      testSteps.push(command({
        key: "grammar-test",
        label: `Test Grammar Checkers${toolchainTag}`,
        command: "divvun-actions run lang-grammar-test",
        depends_on: "grammar-build",
        soft_fail: true,
        timeout_in_minutes: 40,
        agents: {
          queue: "linux",
          ...extra,
        },
      }))
    }
  }

  // Docs data (badge JSON + speller-accuracy.json.gz + testlogs.json) → the repo's rolling
  // `generated/docs-data` orphan branch, which the docs site and README badges
  // read by `raw.githubusercontent.com` URL. main only, soft_fail — never
  // blocks a build. See docs/badgedata-artifact-migration.md.
  const docsSteps: CommandStep[] = []
  if (hasSpellerBuild && !isReleaseTag && builder.env.branch === "main") {
    docsSteps.push(command({
      key: "docs-publish",
      label: "Publish Docs Data",
      command: "divvun-actions run lang-docs-publish",
      depends_on: "speller-test",
      soft_fail: true,
      agents: {
        queue: "linux",
        ...extra,
      },
    }))
  }

  // Bundle phase steps array (only on deploy)
  const bundleSteps: CommandStep[] = []

  if (isSpellerDeploy) {
    bundleSteps.push(command({
      label: "Bundle Speller (Windows)",
      key: "speller-bundle-windows",
      command: "divvun-actions run lang-bundle windows",
      depends_on: "speller-build",
      agents: {
        queue: "windows",
      },
    }))

    bundleSteps.push(command({
      label: "Bundle Speller (Mobile)",
      key: "speller-bundle-mobile",
      command: "divvun-actions run lang-bundle mobile",
      depends_on: "speller-build",
      agents: {
        queue: "linux",
      },
    }))

    bundleSteps.push(command({
      label: "Bundle Speller (macOS)",
      key: "speller-bundle-macos",
      command: "divvun-actions run lang-bundle macos",
      depends_on: "speller-build",
      agents: {
        queue: "macos",
      },
    }))
  }

  // Experimental proofing packages (x-proofing-<lang>): wrap the selected DRB
  // per-OS. soft_fail keeps them from blocking the speller/grammar chain.
  if (proofing && isProofingDeploy) {
    for (
      const [os, queue] of [
        ["macos", "macos"],
        ["windows", "windows"],
        ["linux", "linux"],
      ] as const
    ) {
      bundleSteps.push(command({
        label: `Bundle Proofing (${os})`,
        key: `proofing-bundle-${os}`,
        command: `divvun-actions run lang-proofing-bundle ${os}`,
        depends_on: proofing === "grammar" ? "grammar-build" : "proofing-build",
        soft_fail: true,
        agents: {
          queue,
        },
      }))
    }
  }

  // Deploy phase steps array (only on deploy)
  const deploySteps: CommandStep[] = []

  if (isSpellerDeploy) {
    deploySteps.push(command({
      label: `Deploy Speller (${isSpellerReleaseTag ? "Release" : "Dev"})`,
      command: "divvun-actions run lang-deploy",
      depends_on: [
        "speller-bundle-windows",
        "speller-bundle-mobile",
        "speller-bundle-macos",
      ],
      agents: {
        queue: "linux",
      },
    }))
  }

  if (buildConfig?.["grammar-checkers"] === true && isGrammarDeploy) {
    deploySteps.push(command({
      label: `Deploy Grammar Checker (${
        isGrammarReleaseTag ? "Release" : "Dev"
      })`,
      command: "divvun-actions run lang-grammar-deploy",
      depends_on: "grammar-build",
      agents: {
        queue: "linux",
      },
    }))
  }

  if (proofing && isProofingDeploy) {
    deploySteps.push(command({
      label: `Deploy Proofing (${isProofingReleaseTag ? "Release" : "Dev"})`,
      command: "divvun-actions run lang-proofing-deploy",
      depends_on: [
        "proofing-bundle-macos",
        "proofing-bundle-windows",
        "proofing-bundle-linux",
      ],
      soft_fail: true,
      agents: {
        queue: "linux",
      },
    }))
  }

  if (
    isTtsTextprocReleaseTag ||
    (buildConfig?.["tts-textproc"] === true && isTtsTextprocDeploy)
  ) {
    deploySteps.push(command({
      label: `Deploy TTS Text Processor (${
        isTtsTextprocReleaseTag ? "Release" : "Dev"
      })`,
      command: "divvun-actions run lang-tts-textproc-deploy",
      depends_on: "tts-textproc-build",
      agents: {
        queue: "linux",
      },
    }))
  }

  if (
    canBuildTeaksta &&
    (isTeakstaReleaseTag ||
      (buildConfig?.["teaksta-bundle"] === true && isTeakstaDeploy))
  ) {
    deploySteps.push(command({
      label: `Deploy Teaksta Bundle (${
        isTeakstaReleaseTag ? "Release" : "Dev"
      })`,
      command: "divvun-actions run lang-teaksta-bundle-deploy",
      depends_on: "teaksta-bundle-build",
      agents: {
        queue: "linux",
      },
    }))
  }

  if (isAnalyserDeploy) {
    deploySteps.push(command({
      label: `Deploy Analysers (${isAnalyserReleaseTag ? "Release" : "Dev"})`,
      command: "divvun-actions run lang-analyser-deploy",
      depends_on: "analyser-build",
      agents: {
        queue: "linux",
      },
    }))
  }

  // Construct pipeline with phase-based groups
  const steps: any[] = []

  if (buildSteps.length > 0) {
    steps.push({
      group: "Build",
      key: "build",
      steps: buildSteps,
    })
  }

  if (testSteps.length > 0) {
    steps.push({
      group: "Test",
      key: "test",
      steps: testSteps,
    })
  }

  if (docsSteps.length > 0) {
    steps.push({
      group: "Docs",
      key: "docs",
      steps: docsSteps,
    })
  }

  if (bundleSteps.length > 0) {
    steps.push({
      group: "Bundle",
      key: "bundle",
      steps: bundleSteps,
    })
  }

  if (deploySteps.length > 0) {
    steps.push({
      group: "Deploy",
      key: "deploy",
      steps: deploySteps,
    })
  }

  const pipeline: BuildkitePipeline = {
    steps,
  }

  return pipeline
}
