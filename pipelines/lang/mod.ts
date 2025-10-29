import * as fs from "@std/fs"
import * as semver from "@std/semver"
import * as toml from "@std/toml"
import * as yaml from "@std/yaml"
import grammarBundle from "~/actions/grammar/bundle.ts"
import langBuild from "~/actions/lang/build.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { versionAsNightly } from "~/util/shared.ts"
import spellerBundle from "../../actions/speller/bundle.ts"
import spellerDeploy from "../../actions/speller/deploy.ts"
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

function isConfigActive(config: BuildProps | undefined | null): boolean {
  if (!config) return false
  return Object.entries(config).some(([_key, value]) => {
    if (typeof value === "boolean") return value === true
    if (Array.isArray(value)) return value.length > 0
    if (typeof value === "string") return value.length > 0
    return false
  })
}

export async function runLang() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any

  const buildConfig = config?.build as BuildProps | undefined
  const checkConfig = config?.check as BuildProps | undefined

  const tag = builder.env.tag ?? ""
  const version = extractVersionFromTag(tag)
  const isValidSemver = version !== null && semver.canParse(version)
  const isReleaseTag = isValidSemver &&
    (tag.startsWith("speller-") || tag.startsWith("grammar-"))

  const shouldBuild = isConfigActive(buildConfig)
  const shouldCheck = !isReleaseTag && isConfigActive(checkConfig)

  if (!shouldBuild && !shouldCheck) {
    throw new Error(
      "No build or check configuration found in .build-config.yml",
    )
  }

  if (shouldCheck && !shouldBuild) {
    throw new Error(
      "Cannot run tests without building. Add a 'build:' section.",
    )
  }

  if (shouldBuild) {
    await langBuild(buildConfig!, shouldCheck ? checkConfig : undefined)
  }
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
    return (parsed.prerelease?.length ?? 0) > 0
  } catch {
    return false
  }
}

export async function runLangDeploy() {
  const isSpellerReleaseTag = SPELLER_RELEASE_TAG.test(builder.env.tag ?? "")

  let manifest
  try {
    manifest = toml.parse(
      await Deno.readTextFile("./manifest.toml"),
    ) as SpellerManifest
  } catch (e) {
    logger.error("Failed to read manifest.toml:", e)
    throw e
  }
  const version = await versionAsNightly(manifest.spellerversion)
  const allSecrets = await builder.secrets()

  const secrets = {
    pahkatApiKey: allSecrets.get("pahkat/apiKey"),
    awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
    awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
  }

  await builder.downloadArtifacts("*.txz", ".")
  await builder.downloadArtifacts("*.exe", ".")
  await builder.downloadArtifacts("*.pkg", ".")

  const windowsFiles = await globOneFile("*.exe")
  const macosFiles = await globOneFile("*.pkg")
  const mobileFiles = await globOneFile("*.txz")

  console.log("Deploying language files:")
  console.log(`- Windows: ${windowsFiles}`)
  console.log(`- macOS: ${macosFiles}`)
  console.log(`- Mobile: ${mobileFiles}`)

  if (!windowsFiles || !macosFiles || !mobileFiles) {
    throw new Error("Missing required files for deployment")
  }

  await spellerDeploy({
    spellerType: SpellerType.Windows,
    manifestPath: "./manifest.toml",
    payloadPath: windowsFiles,
    version,
    channel: isSpellerReleaseTag ? null : "nightly",
    pahkatRepo: "https://pahkat.uit.no/main/",
    secrets,
  })

  await spellerDeploy({
    spellerType: SpellerType.MacOS,
    manifestPath: "./manifest.toml",
    payloadPath: macosFiles,
    version,
    channel: isSpellerReleaseTag ? null : "nightly",
    pahkatRepo: "https://pahkat.uit.no/main/",
    secrets,
  })

  await spellerDeploy({
    spellerType: SpellerType.Mobile,
    manifestPath: "./manifest.toml",
    payloadPath: mobileFiles,
    version,
    channel: isSpellerReleaseTag ? null : "nightly",
    pahkatRepo: "https://pahkat.uit.no/main/",
    secrets,
  })

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

    logger.info(`Creating GitHub release for speller version ${tagVersion}`)
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Artifacts: ${windowsFiles}, ${macosFiles}, ${mobileFiles}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [windowsFiles, macosFiles, mobileFiles],
      { prerelease },
    )

    logger.info("Speller GitHub release created successfully")
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
    name: manifest.grammarname || manifest.name || "unknown",
    version: manifest.grammarversion || manifest.version || "0.0.0",
  }

  await grammarBundle({
    manifest: grammarManifest,
    drbPaths: drbFiles,
    zcheckPaths: zcheckFiles,
  })
}

export async function runLangGrammarDeploy() {
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

  if (!builder.env.tag) {
    throw new Error("No tag information available")
  }

  const tagVersion = extractVersionFromTag(builder.env.tag)
  if (!tagVersion) {
    throw new Error(`Could not extract version from tag: ${builder.env.tag}`)
  }

  const prerelease = isPrerelease(tagVersion)
  const langTag = builder.env.repoName.split("lang-")[1]?.split("-")[0] ||
    "unknown"

  const drbFile = drbFiles[0]
  const zcheckFile = zcheckFiles[0]

  const versionedDrbFile = `grammar-${langTag}-${tagVersion}.drb`
  const versionedZcheckFile = `grammar-${langTag}-${tagVersion}.zcheck`

  await Deno.rename(drbFile, versionedDrbFile)
  await Deno.rename(zcheckFile, versionedZcheckFile)

  logger.info(`Creating GitHub release for grammar version ${tagVersion}`)
  logger.info(`Pre-release: ${prerelease}`)
  logger.info(`Artifacts: ${versionedDrbFile}, ${versionedZcheckFile}`)

  const gh = new GitHub(builder.env.repo)
  await gh.createRelease(
    builder.env.tag,
    [versionedDrbFile, versionedZcheckFile],
    { prerelease },
  )

  logger.info("Grammar checker GitHub release created successfully")
}

// Anything using more than like 20gb of RAM is considered large
const LARGE_BUILDS = [
  "lang-kal",
  "lang-sme",
]

export function pipelineLang() {
  const isSpellerReleaseTag = SPELLER_RELEASE_TAG.test(builder.env.tag ?? "")
  const isGrammarReleaseTag = GRAMMAR_RELEASE_TAG.test(builder.env.tag ?? "")

  const extra: Record<string, string> =
    LARGE_BUILDS.includes(builder.env.repoName) ? { size: "large" } : {}

  const first = command({
    key: "build",
    label: "Build",
    command: "divvun-actions run lang",
    agents: {
      queue: "linux",
      ...extra,
    },
  })

  if (extra.size === "large") {
    first.priority = 10
  }

  // We only deploy on main branch or release tags
  const isSpellerDeploy = isSpellerReleaseTag || builder.env.branch === "main"
  const isGrammarDeploy = isGrammarReleaseTag

  const pipeline: BuildkitePipeline = {
    steps: [
      first,
    ],
  }

  if (isSpellerDeploy) {
    pipeline.steps = [
      ...pipeline.steps,
      {
        group: "Bundle",
        key: "bundle",
        depends_on: "build",
        steps: [
          command({
            label: "Bundle (Windows)",
            command: "divvun-actions run lang-bundle windows",
            agents: {
              queue: "windows",
            },
          }),
          command({
            label: "Bundle (Mobile)",
            command: "divvun-actions run lang-bundle mobile",
            agents: {
              queue: "linux",
            },
          }),
          command({
            label: "Bundle (macOS)",
            command: "divvun-actions run lang-bundle macos",
            agents: {
              queue: "macos",
            },
          }),
        ],
      },
      command({
        label: `Deploy (${isSpellerReleaseTag ? "Release" : "Nightly"})`,
        command: "divvun-actions run lang-deploy",
        depends_on: "bundle",
        agents: {
          queue: "linux",
        },
      }),
    ]
  }

  if (isGrammarDeploy) {
    pipeline.steps = [
      ...pipeline.steps,
      command({
        label: "Deploy Grammar Checker",
        command: "divvun-actions run lang-grammar-deploy",
        depends_on: "build",
        agents: {
          queue: "linux",
        },
      }),
    ]
  }

  return pipeline
}
