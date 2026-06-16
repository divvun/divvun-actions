import { pooledMap } from "@std/async/pool"
import logger from "~/util/log.ts"
import { createBuildkiteWebhook } from "./github-client.ts"
import {
  createBuildkitePipeline,
  updateBuildkitePipeline,
} from "./buildkite-client.ts"
import { extractMaturityTag } from "./formatters.ts"
import { PIPELINE_STEPS } from "./types.ts"
import type { SyncGithubProps, SyncOptions, SyncStatus } from "./types.ts"

export async function applyFixes(
  results: SyncStatus[],
  githubProps: Required<SyncGithubProps["github"]>,
  buildkiteProps: Required<SyncGithubProps["buildkite"]>,
  options: SyncOptions = {},
): Promise<void> {
  const dryRun = options.dryRun === true

  // Fix 1: Create missing pipelines
  const noPipelines = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "no-pipeline")
  )

  for (const result of noPipelines) {
    if (dryRun) {
      logger.info(`🚀 Would create pipeline for ${result.repoName}`)
      continue
    }

    logger.info(`🚀 Creating pipeline for ${result.repoName}...`)
    const newPipeline = await createBuildkitePipeline(
      buildkiteProps,
      result.repo,
    )
    logger.info(`✅ Created pipeline: ${newPipeline.name} (${newPipeline.url})`)
  }

  // Fix 2: Update undeclared or stale managed pipeline configuration
  const pipelineConfigOutOfDate = results.filter((r) =>
    r.pipeline &&
    r.discrepancies.some((d) =>
      d.code === "undeclared-configuration" || d.code === "version-mismatch"
    )
  )

  for await (
    const _result of pooledMap(
      3,
      pipelineConfigOutOfDate,
      async (result) => {
        if (!result.pipeline) return

        if (dryRun) {
          logger.info(
            `🧩 Would update managed pipeline configuration for ${result.repoName}`,
          )
          return
        }

        logger.info(
          `🧩 Updating managed pipeline configuration for ${result.repoName}...`,
        )
        try {
          await updateBuildkitePipeline(
            buildkiteProps,
            result.pipeline,
            { configuration: `${PIPELINE_STEPS}\n` },
          )
          logger.info(
            `✅ Updated managed pipeline configuration for ${result.repoName}`,
          )
        } catch (error) {
          logger.error(
            `❌ Failed to update pipeline configuration for ${result.repoName}: ${error}`,
          )
        }
      },
    )
  ) {
    // pooledMap iteration
  }

  // Fix 3: Create missing webhooks
  const noWebhooks = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "no-webhook") && r.pipeline
  )

  for await (
    const _result of pooledMap(
      3,
      noWebhooks,
      async (result) => {
        if (!result.pipeline) return

        if (dryRun) {
          logger.info(
            `🔗 Would create webhook for ${result.repoName}: ${result.pipeline.webhook_url}`,
          )
          return
        }

        logger.info(`🔗 Creating webhook for ${result.repoName}...`)
        try {
          const webhook = await createBuildkiteWebhook(
            githubProps,
            result.repoName,
            result.pipeline,
          )
          logger.info(`✅ Created webhook: ${webhook.config.url}`)
        } catch (error) {
          logger.error(
            `❌ Failed to create webhook for ${result.repoName}: ${error}`,
          )
        }
      },
    )
  ) {
    // pooledMap iteration
  }

  // Fix 4: Update branch configuration
  const noBranchConfig = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "branch-configuration-missing") &&
    r.pipeline
  )

  for await (
    const _result of pooledMap(
      3,
      noBranchConfig,
      async (result) => {
        if (!result.pipeline) return

        let newBranchConfig = "!gh-pages"
        if (
          result.pipeline.branch_configuration &&
          result.pipeline.branch_configuration.trim()
        ) {
          newBranchConfig = `${result.pipeline.branch_configuration} !gh-pages`
        }

        if (dryRun) {
          logger.info(
            `🌿 Would update branch configuration for ${result.repoName}: ${newBranchConfig}`,
          )
          return
        }

        logger.info(
          `🌿 Updating branch configuration for ${result.repoName}...`,
        )
        try {
          await updateBuildkitePipeline(
            buildkiteProps,
            result.pipeline,
            { branch_configuration: newBranchConfig },
          )
          logger.info(`✅ Updated branch configuration: ${newBranchConfig}`)
        } catch (error) {
          logger.error(
            `❌ Failed to update branch configuration for ${result.repoName}: ${error}`,
          )
        }
      },
    )
  ) {
    // pooledMap iteration
  }

  // Fix 5: Enable build_tags
  const tagsNotEnabled = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "tags-not-enabled") && r.pipeline
  )

  for await (
    const _result of pooledMap(
      3,
      tagsNotEnabled,
      async (result) => {
        if (!result.pipeline) return

        if (dryRun) {
          logger.info(`🏷️  Would enable build_tags for ${result.repoName}`)
          return
        }

        logger.info(`🏷️  Enabling build_tags for ${result.repoName}...`)
        try {
          await updateBuildkitePipeline(
            buildkiteProps,
            result.pipeline,
            { provider_settings: { build_tags: true } },
          )
          logger.info(`✅ Enabled build_tags for ${result.repoName}`)
        } catch (error) {
          logger.error(
            `❌ Failed to enable build_tags for ${result.repoName}: ${error}`,
          )
        }
      },
    )
  ) {
    // pooledMap iteration
  }

  // Fix 6: Set build filter
  const filterNotSet = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "filter-not-set") && r.pipeline
  )

  for await (
    const _result of pooledMap(
      3,
      filterNotSet,
      async (result) => {
        if (!result.pipeline) return

        const filterCondition =
          `build.branch != "gh-pages" && build.tag !~ /dev-latest$/`

        if (dryRun) {
          logger.info(
            `🔍 Would set build filter for ${result.repoName}: ${filterCondition}`,
          )
          return
        }

        logger.info(`🔍 Setting build filter for ${result.repoName}...`)
        try {
          await updateBuildkitePipeline(
            buildkiteProps,
            result.pipeline,
            {
              filter_enabled: true,
              filter_condition: filterCondition,
            },
          )
          logger.info(`✅ Set build filter for ${result.repoName}`)
        } catch (error) {
          logger.error(
            `❌ Failed to set build filter for ${result.repoName}: ${error}`,
          )
        }
      },
    )
  ) {
    // pooledMap iteration
  }

  // Fix 7: Enable skip_queued_branch_builds
  const skipQueuedNotEnabled = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "skip-queued-not-enabled") &&
    r.pipeline
  )

  for await (
    const _result of pooledMap(
      3,
      skipQueuedNotEnabled,
      async (result) => {
        if (!result.pipeline) return

        if (dryRun) {
          logger.info(
            `⏭️  Would enable skip_queued_branch_builds for ${result.repoName}`,
          )
          return
        }

        logger.info(
          `⏭️  Enabling skip_queued_branch_builds for ${result.repoName}...`,
        )
        try {
          await updateBuildkitePipeline(
            buildkiteProps,
            result.pipeline,
            {
              skip_queued_branch_builds: true,
              skip_queued_branch_builds_filter: null,
            },
          )
          logger.info(
            `✅ Enabled skip_queued_branch_builds for ${result.repoName}`,
          )
        } catch (error) {
          logger.error(
            `❌ Failed to enable skip_queued_branch_builds for ${result.repoName}: ${error}`,
          )
        }
      },
    )
  ) {
    // pooledMap iteration
  }

  // Fix 8: Sync maturity tags
  const maturityTagsMismatch = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "maturity-tags-mismatch") &&
    r.pipeline &&
    r.repo
  )

  for await (
    const _result of pooledMap(
      3,
      maturityTagsMismatch,
      async (result) => {
        if (!result.pipeline || !result.repo) return

        const expectedMaturityTag = extractMaturityTag(result.repo.topics)
        if (!expectedMaturityTag) return

        const otherTags = result.pipeline.tags.filter((tag) =>
          !tag.startsWith(":package: ")
        )
        const newTags = [...otherTags, expectedMaturityTag]

        if (dryRun) {
          logger.info(
            `📦 Would update maturity tag for ${result.repoName}: ${expectedMaturityTag}`,
          )
          return
        }

        logger.info(`📦 Updating maturity tag for ${result.repoName}...`)
        try {
          await updateBuildkitePipeline(
            buildkiteProps,
            result.pipeline,
            { tags: newTags },
          )
          logger.info(
            `✅ Updated maturity tag for ${result.repoName}: ${expectedMaturityTag}`,
          )
        } catch (error) {
          logger.error(
            `❌ Failed to update maturity tag for ${result.repoName}: ${error}`,
          )
        }
      },
    )
  ) {
    // pooledMap iteration
  }
}
