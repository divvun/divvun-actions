import type { BuildkitePipeline, Step } from "~/builder/pipeline.ts"
import { validatePipeline } from "~/builder/pipeline.ts"

export type Props = {
  os: Set<"linux" | "windows" | "macos">
  deploy?: boolean
}

export function pipeline({ os, deploy = false }: Props) {
  // steps:
  // - label: ":hammer: Build ({{matrix.os}})"
  //   command: "divvun-actions divvunspell build --target {{matrix.os}}"
  //   key: build
  //   matrix:
  //     setup:
  //       os:
  //         - linux
  //         - windows
  //         - macos
  //   agents:
  //     queue: "{{matrix.os}}"

  const steps: Step[] = []

  steps.push({
    label: ":hammer: Build ({{matrix.os}})",
    command: "divvun-actions divvunspell build --target {{matrix.os}}",
    key: "build",
    matrix: {
      setup: {
        os: [...os],
      },
    },
    agents: {
      queue: "{{matrix.os}}",
    },
  })

  const pipeline: BuildkitePipeline = {
    steps,
  }

  return validatePipeline(pipeline)
}
