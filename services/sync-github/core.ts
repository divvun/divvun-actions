import { pooledMap } from "@std/async/pool"
import logger from "~/util/log.ts"
import { listGithubRepos, listGithubWebhooks } from "./github-client.ts"
import { listBuildkitePipelines } from "./buildkite-client.ts"
import { assessStatus } from "./assessor.ts"
import { applyFixes } from "./fixer.ts"
import { extractMaturityValue, prettyPrintSyncResults } from "./formatters.ts"
import type {
  GithubWebhook,
  PackageChannels,
  StatusEntry,
  SyncGithubProps,
  SyncStatus,
} from "./types.ts"

/**
 * Get sync status for all repositories (read-only, no fixes applied)
 */
export async function getStatus(props: SyncGithubProps): Promise<SyncStatus[]> {
  const githubProps = props.github as Required<SyncGithubProps["github"]>
  const buildkiteProps = props.buildkite as Required<
    SyncGithubProps["buildkite"]
  >

  logger.info("🔍 Getting pipelines...")
  const pipelines = await listBuildkitePipelines(buildkiteProps)

  logger.info("🔍 Getting repos...")
  const allRepos = await listGithubRepos(githubProps)
  const repos = allRepos.filter((repo) => {
    return repo.name.includes("lang-") || repo.name.includes("keyboard-")
  })

  logger.info("🔄 Assessing sync status...")
  const results: SyncStatus[] = []

  for await (
    const status of pooledMap(
      5,
      repos,
      async (repo) => {
        logger.info(`🔍 Checking ${repo.name}...`)
        let webhooks: GithubWebhook[] = []
        try {
          webhooks = await listGithubWebhooks(githubProps, repo.name)
        } catch (error) {
          logger.warning(
            `⚠️ Could not fetch webhooks for ${repo.name}: ${error}`,
          )
        }

        return assessStatus(repo, pipelines, webhooks)
      },
    )
  ) {
    results.push(status)
  }

  return results
}

/**
 * Perform full sync: assess status and apply fixes
 */
export async function syncAndFix(
  props: SyncGithubProps,
): Promise<SyncStatus[]> {
  const githubProps = props.github as Required<SyncGithubProps["github"]>
  const buildkiteProps = props.buildkite as Required<
    SyncGithubProps["buildkite"]
  >

  logger.info("🔍 Getting pipelines...")
  const pipelines = await listBuildkitePipelines(buildkiteProps)

  logger.info("🔍 Getting repos...")
  const allRepos = await listGithubRepos(githubProps)
  const repos = allRepos.filter((repo) => {
    return repo.name.includes("lang-") || repo.name.includes("keyboard-")
  })

  logger.info("🔄 Assessing sync status...")
  const results: SyncStatus[] = []

  for await (
    const status of pooledMap(
      5,
      repos,
      async (repo) => {
        logger.info(`🔍 Checking webhooks for ${repo.name}...`)
        let webhooks: GithubWebhook[] = []
        try {
          webhooks = await listGithubWebhooks(githubProps, repo.name)
        } catch (error) {
          logger.warning(
            `⚠️ Could not fetch webhooks for ${repo.name}: ${error}`,
          )
        }

        return assessStatus(repo, pipelines, webhooks)
      },
    )
  ) {
    results.push(status)
  }

  prettyPrintSyncResults(results)

  logger.info("\n🔧 Applying fixes...")
  await applyFixes(results, githubProps, buildkiteProps)

  return results
}

/**
 * Write status.json file with maturity and package version information
 */
export async function writeStatusJson(
  results: SyncStatus[],
  releasesByRepo: Record<string, Record<string, PackageChannels>>,
  outputPath = "status.json",
): Promise<void> {
  logger.info(`📝 Writing ${outputPath}...`)
  const statusData: Record<string, StatusEntry> = {}

  for (const result of results) {
    if (!result.pipeline) continue

    const maturityValue = extractMaturityValue(result.pipeline.tags)
    if (maturityValue) {
      const packages = releasesByRepo[result.repoName]
      const statusEntry: StatusEntry = { maturity: maturityValue }

      if (packages && Object.keys(packages).length > 0) {
        statusEntry.packages = packages
      }

      statusData[result.pipeline.slug] = statusEntry
    }
  }

  try {
    await Deno.writeTextFile(
      outputPath,
      JSON.stringify(statusData, null, 2),
    )
    logger.info(
      `✅ Wrote status for ${
        Object.keys(statusData).length
      } pipelines to ${outputPath}`,
    )
  } catch (error) {
    logger.error(`❌ Failed to write ${outputPath}: ${error}`)
  }
}
