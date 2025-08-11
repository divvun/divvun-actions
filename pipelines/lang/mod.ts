import * as fs from "@std/fs"
import * as toml from "@std/toml"
import * as yaml from "@std/yaml"
import langBuild, { Props } from "~/actions/lang/build.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import spellerBundle from "../../actions/speller/bundle.ts"
import spellerDeploy from "../../actions/speller/deploy.ts"
import { SpellerManifest, SpellerType } from "../../actions/speller/manifest.ts"
import { versionAsNightly } from "../../util/shared.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export async function runLang() {
  const yml = await Deno.readTextFile(".build-config.yml")
  const config = (await yaml.parse(yml) as any)?.build as Props

  console.log(await langBuild(config))
}

export async function runLangBundle(
  { target }: { target: "windows" | "macos" | "mobile" },
) {
  await builder.downloadArtifacts("build/tools/spellcheckers/*.zhfst", ".")

  const spellerPaths = JSON.parse(await builder.metadata("speller-paths"))
  const manifest = toml.parse(
    await Deno.readTextFile("./manifest.toml"),
  ) as SpellerManifest

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
  // const yml = await Deno.readTextFile(".build-config.yml")
  // const config = (await yaml.parse(yml) as any)?.build as Props

  // console.log(await langBuild(config))
}


// export type Props = {
//   spellerType: SpellerType
//   manifestPath: string
//   payloadPath: string
//   version: string
//   channel: string | null
//   nightlyChannel: string
//   pahkatRepo: string
//   secrets: {
//     pahkatApiKey: string
//     awsAccessKeyId: string
//     awsSecretAccessKey: string
//   }
// }

async function globOneFile(pattern: string): Promise<string | null> {
  const files = await fs.expandGlob(pattern)
  for await (const file of files) {
    if (file.isFile) {
      return file.path
    }
  }
  return null
}

export async function runLangDeploy() {
  const manifest = toml.parse(
    await Deno.readTextFile("./manifest.toml"),
  ) as SpellerManifest
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
    channel: "nightly",
    pahkatRepo: "https://pahkat.uit.no/main/",
    secrets,
  })

  await spellerDeploy({
    spellerType: SpellerType.MacOS,
    manifestPath: "./manifest.toml",
    payloadPath: macosFiles,
    version,
    channel: "nightly",
    pahkatRepo: "https://pahkat.uit.no/main/",
    secrets,
  })

  await spellerDeploy({
    spellerType: SpellerType.Mobile,
    manifestPath: "./manifest.toml",
    payloadPath: mobileFiles,
    version,
    channel: "nightly",
    pahkatRepo: "https://pahkat.uit.no/main/",
    secrets,
  })
}

export function pipelineLang() {
  const pipeline: BuildkitePipeline = {
    steps: [
      command({
        key: "build",
        label: "Build",
        command: "divvun-actions run lang",
        agents: {
          queue: "linux",
        },
      }),
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
        ]
      },
      command({
        label: "Deploy",
        command: "divvun-actions run lang-deploy",
        depends_on: "bundle",
        agents: {
          queue: "linux",
        },
      }),
    ],
  }

  return pipeline
}
