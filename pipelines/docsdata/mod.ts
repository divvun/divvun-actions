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

/**
 * The whole pipeline for a repo that only ever needs to publish
 * `generated/docs-data` — `shared-*`, `giella-core`, `template-*`. No FST or
 * speller build, so unlike `pipelineLang()` there is nothing else to run:
 * one step, `main` only. See `actions/docsdata/publish.ts`.
 */
export function pipelineDocsData(): BuildkitePipeline {
  const steps: CommandStep[] = [
    command({
      key: "docs-publish",
      label: "Publish Docs Data",
      command: "divvun-actions run docs-data-publish",
      branches: "main",
      soft_fail: true,
      agents: {
        queue: "linux",
      },
    }),
  ]

  return { steps: [{ group: "Docs", key: "docs", steps }] }
}
