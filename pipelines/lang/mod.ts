import * as yaml from "@std/yaml"
import langBuild, { Props } from "~/actions/lang/build.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

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

  console.log("target", target, spellerPaths)
  // const yml = await Deno.readTextFile(".build-config.yml")
  // const config = (await yaml.parse(yml) as any)?.build as Props

  // console.log(await langBuild(config))
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
      command({
        label: "Bundle (Windows)",
        command: "divvun-actions run lang-bundle windows",
        depends_on: "build",
        agents: {
          queue: "windows",
        },
      }),
      command({
        label: "Bundle (Mobile)",
        command: "divvun-actions run lang-bundle mobile",
        depends_on: "build",
        agents: {
          queue: "linux",
        },
      }),
      command({
        label: "Bundle (macOS)",
        command: "divvun-actions run lang-bundle macos",
        depends_on: "build",
        agents: {
          queue: "macos",
        },
      }),
    ],
  }

  return pipeline
}
