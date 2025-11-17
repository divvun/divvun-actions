import { hasWebhookForPipeline } from "./github-client.ts"
import { extractMaturityTag } from "./formatters.ts"
import type {
  BuildkitePipeline,
  GithubRepo,
  GithubWebhook,
  SyncStatus,
} from "./types.ts"
import { CUR_VERSION, V_REGEX } from "./types.ts"

export function assessStatus(
  repo: GithubRepo,
  pipelines: BuildkitePipeline[],
  webhooks?: GithubWebhook[],
): SyncStatus {
  const pipeline = pipelines.find((p) => {
    const pipelineRepo = p.repository.replace(/\.git$/, "").split(":")[1]
    return pipelineRepo === repo.name
  })

  if (!pipeline) {
    return {
      repoName: repo.name,
      pipelineName: null,
      inSync: false,
      discrepancies: [{
        code: "no-pipeline",
        message: "No corresponding Buildkite pipeline found.",
      }],
      repo,
    }
  }

  const discrepancies: SyncStatus["discrepancies"] = []

  if (/# Managed by Divvun Actions/.test(pipeline.configuration)) {
    const versionMatch = pipeline.configuration.match(V_REGEX)?.[1]
    const version = versionMatch ? parseInt(versionMatch, 10) : null

    if (version !== CUR_VERSION) {
      discrepancies.push({
        code: "version-mismatch",
        message:
          `Pipeline configuration version mismatch. Expected ${CUR_VERSION}, found ${version}.`,
      })
    }
  } else if (!/# Custom/.test(pipeline.configuration)) {
    discrepancies.push({
      code: "undeclared-configuration",
      message:
        "Pipeline configuration is missing declaration of managed or custom.",
    })
  }

  if (webhooks) {
    const hasWebhook = hasWebhookForPipeline(webhooks, pipeline)
    if (!hasWebhook) {
      discrepancies.push({
        code: "no-webhook",
        message: "No corresponding webhook found for the Buildkite pipeline.",
      })
    }
  }

  // Check branch configuration
  if (
    !pipeline.branch_configuration ||
    !pipeline.branch_configuration.includes("!gh-pages")
  ) {
    discrepancies.push({
      code: "branch-configuration-missing",
      message:
        "Pipeline branch configuration is missing or does not exclude gh-pages branch.",
    })
  }

  // Check if build_tags is enabled
  if (pipeline.provider?.settings?.build_tags !== true) {
    discrepancies.push({
      code: "tags-not-enabled",
      message: "Pipeline does not have build_tags enabled.",
    })
  }

  // Check if skip_queued_branch_builds is enabled
  if (pipeline.skip_queued_branch_builds !== true) {
    discrepancies.push({
      code: "skip-queued-not-enabled",
      message: "Pipeline does not have skip_queued_branch_builds enabled.",
    })
  }

  // Check if build filter is properly set
  const expectedFilter =
    `build.branch != "gh-pages" && build.tag !~ /dev-latest$/`
  if (
    pipeline.filter_enabled !== true ||
    pipeline.filter_condition !== expectedFilter
  ) {
    discrepancies.push({
      code: "filter-not-set",
      message: "Pipeline does not have build filter properly configured.",
    })
  }

  // Check maturity tag sync
  const expectedMaturityTag = extractMaturityTag(repo.topics)
  if (expectedMaturityTag) {
    const pipelinePackageTags = pipeline.tags.filter((tag) =>
      tag.startsWith(":package: ")
    )
    const hasCorrectMaturityTag = pipelinePackageTags.includes(
      expectedMaturityTag,
    )

    if (!hasCorrectMaturityTag) {
      discrepancies.push({
        code: "maturity-tags-mismatch",
        message:
          `Pipeline maturity tag mismatch. Expected "${expectedMaturityTag}", found: ${
            pipelinePackageTags.length > 0
              ? pipelinePackageTags.join(", ")
              : "none"
          }`,
      })
    }
  }

  return {
    repoName: repo.name,
    pipelineName: pipeline.name,
    inSync: discrepancies.length === 0,
    discrepancies,
    repo,
    pipeline,
  }
}
