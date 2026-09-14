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
 *
 * Not `soft_fail`, unlike lang-'s docs-publish step: there this is one step
 * among many and badges are secondary to the actual language build, so a
 * failure here shouldn't block a release. Here it's the *only* step, so
 * soft-failing it would mean the build can never go red no matter what
 * breaks (a bad publish, a script regression, ...) -- there's nothing else
 * for a real failure to show up against. Badge-script failures already
 * degrade gracefully inside the action itself (warn and move on, see
 * actions/docsdata/publish.ts); what reaches Buildkite as a thrown error is
 * specifically "nothing got published," which is worth a red build.
 */
export function pipelineDocsData(): BuildkitePipeline {
  const steps: CommandStep[] = [
    command({
      key: "docs-publish",
      label: "Publish Docs Data",
      command: "divvun-actions run docs-data-publish",
      branches: "main",
      agents: {
        queue: "linux",
      },
    }),
  ]

  return { steps: [{ group: "Docs", key: "docs", steps }] }
}
