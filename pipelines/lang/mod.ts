import * as fs from "@std/fs"
import * as toml from "@std/toml"
import * as yaml from "@std/yaml"
import langBuild from "~/actions/lang/build.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
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

export async function runLang() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = await yaml.parse(yml) as any
  const buildConfig = config?.build as BuildProps
  const checkConfig = config?.check as BuildProps

  logger.debug(await langBuild(buildConfig, checkConfig))
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

const RELEASE_TAG = /^speller-(.*?)\/v\d+\.\d+\.\d+(-\S+)?/

export async function runLangDeploy() {
  const isSpellerReleaseTag = RELEASE_TAG.test(builder.env.tag ?? "")

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
}

// Anything using more than like 20gb of RAM is considered large
const LARGE_BUILDS = [
  "lang-kal",
  "lang-sme",
]

export function pipelineLang() {
  const isSpellerReleaseTag = RELEASE_TAG.test(builder.env.tag ?? "")

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

  // We only deploy on main branch
  const isDeploy = builder.env.branch === "main"

  const pipeline: BuildkitePipeline = {
    steps: [
      first,
    ],
  }

  if (isDeploy) {
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

  return pipeline
}
