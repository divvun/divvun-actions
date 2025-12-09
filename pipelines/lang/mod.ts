import * as fs from "@std/fs"
import * as semver from "@std/semver"
import * as toml from "@std/toml"
import * as yaml from "@std/yaml"
import grammarBundle from "~/actions/grammar/bundle.ts"
import langGrammarBuild from "~/actions/lang/build-grammar.ts"
import langSpellerBuild from "~/actions/lang/build-speller.ts"
import langTtsTextprocBuild from "~/actions/lang/build-tts-textproc.ts"
import langBuild from "~/actions/lang/build.ts"
import langCheck from "~/actions/lang/check.ts"
import langGrammarTest from "~/actions/lang/test-grammar.ts"
import langSpellerTest from "~/actions/lang/test-speller.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import { versionAsDev } from "~/util/shared.ts"
import spellerBundle from "../../actions/speller/bundle.ts"
import { SpellerManifest, SpellerType } from "../../actions/speller/manifest.ts"
import logger from "../../util/log.ts"

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

function isConfigActive(config: BuildProps | undefined | null): boolean {
  if (!config) return false
  return Object.entries(config).some(([_key, value]) => {
    if (typeof value === "boolean") return value === true
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "string") return value.length > 0
    return false
  })
}

export async function runLangBuild() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const buildConfig = config?.build as BuildProps | undefined

  const shouldBuild = isConfigActive(buildConfig)

  if (!shouldBuild) {
    throw new Error(
      "No build configuration found in .build-config.yml",
    )
  }

  await langBuild(buildConfig!)
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
  await builder.downloadArtifacts("build/tools/spellcheckers/*.zhfst", ".")

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

async function globOneFile(pattern: string): Promise<string | null> {
  const files = await fs.expandGlob(pattern)
  for await (const file of files) {
    if (file.isFile) {
      return file.path
    }
  }
  return null
}

async function globFiles(pattern: string): Promise<string[]> {
  const files = await fs.expandGlob(pattern)
  const result: string[] = []
  for await (const file of files) {
    if (file.isFile) {
      result.push(file.path)
    }
  }
  return result
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
  await builder.downloadArtifacts("*.exe", ".")
  await builder.downloadArtifacts("*.pkg", ".")

  const windowsFiles = await globOneFile("*.exe")
  const macosFiles = await globOneFile("*.pkg")
  const mobileFiles = await globOneFile("*.pkt.tar.zst")

  console.log("Deploying language files:")
  console.log(`- Windows: ${windowsFiles}`)
  console.log(`- macOS: ${macosFiles}`)
  console.log(`- Mobile: ${mobileFiles}`)

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
      `${packageName}_${versionWithBuild}_noarch-macos.pkg`
    const versionedMobileFile =
      `${packageName}_${versionWithBuild}_noarch-mobile.pkt.tar.zst`

    await Deno.rename(windowsFiles, versionedWindowsFile)
    await Deno.rename(macosFiles, versionedMacosFile)
    await Deno.rename(mobileFiles, versionedMobileFile)

    const artifacts = [
      versionedWindowsFile,
      versionedMacosFile,
      versionedMobileFile,
    ]
    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.secrets(),
    )

    logger.info(`Creating GitHub release for speller version ${tagVersion}`)
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifacts: ${artifacts.join(", ")}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [...artifacts, checksumFile, signatureFile],
      { prerelease },
    )

    logger.info("Speller GitHub release created successfully")
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
    const versionedMacosFile = `${packageName}_${devVersion}_noarch-macos.pkg`
    const versionedMobileFile =
      `${packageName}_${devVersion}_noarch-mobile.pkt.tar.zst`

    await Deno.rename(windowsFiles, versionedWindowsFile)
    await Deno.rename(macosFiles, versionedMacosFile)
    await Deno.rename(mobileFiles, versionedMobileFile)

    const artifacts = [
      versionedWindowsFile,
      versionedMacosFile,
      versionedMobileFile,
    ]
    const { checksumFile, signatureFile } = await createSignedChecksums(
      artifacts,
      await builder.secrets(),
    )

    logger.info(
      `Creating dev-latest GitHub release for speller version ${devVersion}`,
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

    logger.info("Speller dev-latest GitHub release updated successfully")
  }
}

export async function runLangGrammarBundle() {
  await builder.downloadArtifacts("*.drb", ".")
  await builder.downloadArtifacts("*.zcheck", ".")

  const drbFiles = await globFiles("build/tools/grammarcheckers/*.drb")
  const zcheckFiles = await globFiles("build/tools/grammarcheckers/*.zcheck")

  let manifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as any
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }

  const grammarManifest = {
    name: manifest.package.grammar.name,
    version: manifest.package.grammar.version,
  }

  await grammarBundle({
    manifest: grammarManifest,
    drbPaths: drbFiles,
    zcheckPaths: zcheckFiles,
  })
}

export async function runLangGrammarDeploy() {
  const isGrammarReleaseTag = GRAMMAR_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  await builder.downloadArtifacts("*.drb", ".")
  await builder.downloadArtifacts("*.zcheck", ".")

  const drbFiles = await globFiles("build/tools/grammarcheckers/*.drb")
  const zcheckFiles = await globFiles("build/tools/grammarcheckers/*.zcheck")

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
      await builder.secrets(),
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
      await builder.secrets(),
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

export async function runLangTtsTextprocDeploy() {
  const isTtsReleaseTag = TTS_TEXTPROC_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  await builder.downloadArtifacts("build/tools/tts/*", ".")

  const ttsFiles = await globFiles("build/tools/tts/*")

  if (ttsFiles.length === 0) {
    throw new Error("No TTS text processor files found for deployment")
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

    // Create versioned filenames for all TTS files
    const versionedFiles: string[] = []

    for (const file of ttsFiles) {
      const basename = file.split("/").pop()!
      const ext = basename.includes(".") ? "." + basename.split(".").pop() : ""
      const nameWithoutExt = ext ? basename.slice(0, -ext.length) : basename
      const versionedName =
        `${packageName}_${versionWithBuild}_${nameWithoutExt}${ext}`

      await Deno.rename(file, versionedName)
      versionedFiles.push(versionedName)
    }

    const { checksumFile, signatureFile } = await createSignedChecksums(
      versionedFiles,
      await builder.secrets(),
    )

    logger.info(
      `Creating GitHub release for TTS text processor version ${tagVersion}`,
    )
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifacts: ${versionedFiles.join(", ")}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [...versionedFiles, checksumFile, signatureFile],
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

    // Create versioned filenames for all TTS files
    const versionedFiles: string[] = []

    for (const file of ttsFiles) {
      const basename = file.split("/").pop()!
      const ext = basename.includes(".") ? "." + basename.split(".").pop() : ""
      const nameWithoutExt = ext ? basename.slice(0, -ext.length) : basename
      const versionedName =
        `${packageName}_${devVersion}_${nameWithoutExt}${ext}`

      await Deno.rename(file, versionedName)
      versionedFiles.push(versionedName)
    }

    const { checksumFile, signatureFile } = await createSignedChecksums(
      versionedFiles,
      await builder.secrets(),
    )

    logger.info(
      `Creating dev-latest GitHub release for TTS text processor version ${devVersion}`,
    )
    logger.info(`Release tag: ${releaseTag}`)
    logger.info(`Artifacts: ${versionedFiles.join(", ")}`)

    const releaseName = `${packageName}/v${devVersion}`
    const gh = new GitHub(builder.env.repo)
    await gh.updateRelease(
      releaseTag,
      [...versionedFiles, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: releaseName },
    )

    logger.info(
      "TTS text processor dev-latest GitHub release updated successfully",
    )
  }
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
  const isReleaseTag = isSpellerReleaseTag || isGrammarReleaseTag ||
    isTtsTextprocReleaseTag

  const extra: Record<string, string> =
    LARGE_BUILDS.includes(builder.env.repoName) ? { size: "large" } : {}

  // Read build configuration to check if grammar-checkers are enabled
  let buildConfig: BuildProps | undefined
  try {
    const yml = await Deno.readTextFile(".build-config.yml")
    const config = await yaml.parse(yml) as any
    buildConfig = config?.build as BuildProps | undefined
  } catch {
    // Config file not found or invalid, buildConfig remains undefined
  }

  // Separate build steps for spellers and grammar checkers
  const spellerBuildStep = command({
    key: "speller-build",
    label: "Build Spellers",
    command: "divvun-actions run lang-speller-build",
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
    label: "Build Grammar Checkers",
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
    label: "Build TTS Text Processor",
    command: "divvun-actions run lang-tts-textproc-build",
    agents: {
      queue: "linux",
      ...extra,
    },
  })

  if (extra.size === "large") {
    ttsTextprocBuildStep.priority = 10
  }

  // We only deploy on main branch or release tags
  const isSpellerDeploy = isSpellerReleaseTag || builder.env.branch === "main"
  const isGrammarDeploy = isGrammarReleaseTag || builder.env.branch === "main"
  const isTtsTextprocDeploy = isTtsTextprocReleaseTag ||
    builder.env.branch === "main"

  // Build phase steps array
  const buildSteps: CommandStep[] = [spellerBuildStep]

  if (
    buildConfig?.["grammar-checkers"] === true &&
    (isGrammarReleaseTag || !isSpellerReleaseTag)
  ) {
    buildSteps.push(grammarBuildStep)
  }

  if (
    buildConfig?.["tts-textproc"] === true &&
    (isTtsTextprocReleaseTag || !isSpellerReleaseTag)
  ) {
    buildSteps.push(ttsTextprocBuildStep)
  }

  // Test phase steps array (only on non-release builds)
  const testSteps: CommandStep[] = []

  if (!isReleaseTag) {
    testSteps.push(command({
      key: "speller-test",
      label: "Test Spellers",
      command: "divvun-actions run lang-speller-test",
      depends_on: "speller-build",
      soft_fail: true,
      agents: {
        queue: "linux",
        ...extra,
      },
    }))

    if (
      buildConfig?.["grammar-checkers"] === true &&
      (isGrammarReleaseTag || !isSpellerReleaseTag)
    ) {
      testSteps.push(command({
        key: "grammar-test",
        label: "Test Grammar Checkers",
        command: "divvun-actions run lang-grammar-test",
        depends_on: "grammar-build",
        soft_fail: true,
        agents: {
          queue: "linux",
          ...extra,
        },
      }))
    }
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

  if (buildConfig?.["grammar-checkers"] === true && isGrammarDeploy) {
    bundleSteps.push(command({
      label: "Bundle Grammar Checker",
      key: "grammar-bundle",
      command: "divvun-actions run lang-grammar-bundle",
      depends_on: "grammar-build",
      agents: {
        queue: "linux",
      },
    }))
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
      depends_on: "grammar-bundle",
      agents: {
        queue: "linux",
      },
    }))
  }

  if (buildConfig?.["tts-textproc"] === true && isTtsTextprocDeploy) {
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

  // Construct pipeline with phase-based groups
  const steps: any[] = [
    {
      group: "Build",
      key: "build",
      steps: buildSteps,
    },
  ]

  if (testSteps.length > 0) {
    steps.push({
      group: "Test",
      key: "test",
      steps: testSteps,
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
