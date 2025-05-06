import * as yaml from "@std/yaml"
import langBuild, { Props } from "~/actions/lang/build.ts"
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
  const config = await yaml.parse(yml) as Props

  console.log(await langBuild(config))
}

export function pipelineLang() {
  const pipeline: BuildkitePipeline = {
    steps: [
      command({
        label: "Build",
        command: "divvun-actions run lang",
        agents: {
          queue: "linux",
        },
      }),
    ],
  }

  return pipeline
}
