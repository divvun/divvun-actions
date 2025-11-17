import { createBuildkiteWebhook } from "./github-client.ts"
import {
  createBuildkitePipeline,
  updateBuildkitePipeline,
} from "./buildkite-client.ts"
import { extractMaturityTag } from "./formatters.ts"
import type { SyncGithubProps, SyncStatus } from "./types.ts"

export async function applyFixes(
  results: SyncStatus[],
  githubProps: Required<SyncGithubProps["github"]>,
  buildkiteProps: Required<SyncGithubProps["buildkite"]>,
): Promise<void> {
  // Fix 1: Create missing pipelines
  const noPipelines = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "no-pipeline")
  )

  for (const result of noPipelines) {
    console.log(`🚀 Creating pipeline for ${result.repoName}...`)
    const newPipeline = await createBuildkitePipeline(
      buildkiteProps,
      result.repo,
    )
    console.log(`✅ Created pipeline: ${newPipeline.name} (${newPipeline.url})`)
  }

  // Fix 2: Create missing webhooks
  const noWebhooks = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "no-webhook") && r.pipeline
  )

  for (const result of noWebhooks) {
    if (!result.pipeline) continue

    console.log(`🔗 Creating webhook for ${result.repoName}...`)
    try {
      const webhook = await createBuildkiteWebhook(
        githubProps,
        result.repoName,
        result.pipeline,
      )
      console.log(`✅ Created webhook: ${webhook.config.url}`)
    } catch (error) {
      console.error(
        `❌ Failed to create webhook for ${result.repoName}: ${error}`,
      )
    }
  }

  // Fix 3: Update branch configuration
  const noBranchConfig = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "branch-configuration-missing") &&
    r.pipeline
  )

  for (const result of noBranchConfig) {
    if (!result.pipeline) continue

    console.log(`🌿 Updating branch configuration for ${result.repoName}...`)
    try {
      let newBranchConfig = "!gh-pages"

      // If there's an existing branch configuration, append to it
      if (
        result.pipeline.branch_configuration &&
        result.pipeline.branch_configuration.trim()
      ) {
        newBranchConfig = `${result.pipeline.branch_configuration} !gh-pages`
      }

      await updateBuildkitePipeline(
        buildkiteProps,
        result.pipeline,
        { branch_configuration: newBranchConfig },
      )
      console.log(`✅ Updated branch configuration: ${newBranchConfig}`)
    } catch (error) {
      console.error(
        `❌ Failed to update branch configuration for ${result.repoName}: ${error}`,
      )
    }
  }

  // Fix 4: Enable build_tags
  const tagsNotEnabled = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "tags-not-enabled") && r.pipeline
  )

  for (const result of tagsNotEnabled) {
    if (!result.pipeline) continue

    console.log(`🏷️  Enabling build_tags for ${result.repoName}...`)
    try {
      await updateBuildkitePipeline(
        buildkiteProps,
        result.pipeline,
        { provider_settings: { build_tags: true } },
      )
      console.log(`✅ Enabled build_tags for ${result.repoName}`)
    } catch (error) {
      console.error(
        `❌ Failed to enable build_tags for ${result.repoName}: ${error}`,
      )
    }
  }

  // Fix 5: Set build filter
  const filterNotSet = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "filter-not-set") && r.pipeline
  )

  for (const result of filterNotSet) {
    if (!result.pipeline) continue

    console.log(`🔍 Setting build filter for ${result.repoName}...`)
    try {
      await updateBuildkitePipeline(
        buildkiteProps,
        result.pipeline,
        {
          filter_enabled: true,
          filter_condition:
            `build.branch != "gh-pages" && build.tag !~ /dev-latest$/`,
        },
      )
      console.log(`✅ Set build filter for ${result.repoName}`)
    } catch (error) {
      console.error(
        `❌ Failed to set build filter for ${result.repoName}: ${error}`,
      )
    }
  }

  // Fix 6: Enable skip_queued_branch_builds
  const skipQueuedNotEnabled = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "skip-queued-not-enabled") &&
    r.pipeline
  )

  for (const result of skipQueuedNotEnabled) {
    if (!result.pipeline) continue

    console.log(
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
      console.log(`✅ Enabled skip_queued_branch_builds for ${result.repoName}`)
    } catch (error) {
      console.error(
        `❌ Failed to enable skip_queued_branch_builds for ${result.repoName}: ${error}`,
      )
    }
  }

  // Fix 7: Sync maturity tags
  const maturityTagsMismatch = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "maturity-tags-mismatch") &&
    r.pipeline &&
    r.repo
  )

  for (const result of maturityTagsMismatch) {
    if (!result.pipeline || !result.repo) continue

    const expectedMaturityTag = extractMaturityTag(result.repo.topics)
    if (!expectedMaturityTag) continue

    console.log(`📦 Updating maturity tag for ${result.repoName}...`)
    try {
      // Remove old :package: tags and add the new one
      const otherTags = result.pipeline.tags.filter((tag) =>
        !tag.startsWith(":package: ")
      )
      const newTags = [...otherTags, expectedMaturityTag]

      await updateBuildkitePipeline(
        buildkiteProps,
        result.pipeline,
        { tags: newTags },
      )
      console.log(
        `✅ Updated maturity tag for ${result.repoName}: ${expectedMaturityTag}`,
      )
    } catch (error) {
      console.error(
        `❌ Failed to update maturity tag for ${result.repoName}: ${error}`,
      )
    }
  }
}
