import type { DiscrepancyCode, SyncStatus } from "./types.ts"
import logger from "~/util/log.ts"

export function extractMaturityTag(topics: string[]): string | null {
  const maturityTopic = topics.find((topic) => topic.startsWith("maturity-"))
  if (!maturityTopic) {
    return null
  }

  const maturityLevel = maturityTopic.split("-")[1]
  return `:package: ${maturityLevel}`
}

export function extractMaturityValue(tags: string[]): string | null {
  const packageTag = tags.find((tag) => tag.startsWith(":package: "))
  if (!packageTag) {
    return null
  }

  return packageTag.split(" ")[1]
}

export function prettyPrintSyncResults(results: SyncStatus[]): void {
  const inSyncCount = results.filter((r) => r.inSync).length
  const outOfSyncCount = results.length - inSyncCount

  logger.info(`\n📊 Sync Status Summary`)
  logger.info(`${"=".repeat(50)}`)
  logger.info(`✅ In sync: ${inSyncCount}`)
  logger.info(`❌ Out of sync: ${outOfSyncCount}`)
  logger.info(`📦 Total repositories: ${results.length}`)
  logger.info()

  // Group results by sync status
  const inSync = results.filter((r) => r.inSync)
  const outOfSync = results.filter((r) => !r.inSync)

  if (inSync.length > 0) {
    logger.info(`✅ Repositories in sync:`)
    logger.info(`${"─".repeat(30)}`)
    for (const result of inSync) {
      logger.info(`  📁 ${result.repoName}`)
      if (result.pipelineName) {
        logger.info(`     🔧 Pipeline: ${result.pipelineName}`)
      }
    }
    logger.info()
  }

  if (outOfSync.length > 0) {
    logger.info(`❌ Repositories out of sync:`)
    logger.info(`${"─".repeat(35)}`)
    for (const result of outOfSync) {
      logger.info(`  📁 ${result.repoName}`)
      if (result.pipelineName) {
        logger.info(`     🔧 Pipeline: ${result.pipelineName}`)
      } else {
        logger.info(`     🔧 Pipeline: None`)
      }

      for (const discrepancy of result.discrepancies) {
        const icon = getDiscrepancyIcon(discrepancy.code)
        logger.info(`     ${icon} ${discrepancy.message}`)
      }
      logger.info()
    }
  }
}

export function getDiscrepancyIcon(code: DiscrepancyCode): string {
  switch (code) {
    case "no-pipeline":
      return "🚫"
    case "version-mismatch":
      return "🔄"
    case "undeclared-configuration":
      return "⚠️"
    case "no-webhook":
      return "🔗"
    case "branch-configuration-missing":
      return "🌿"
    case "tags-not-enabled":
      return "🏷️"
    case "skip-queued-not-enabled":
      return "⏭️"
    case "maturity-tags-mismatch":
      return "📦"
    case "filter-not-set":
      return "🔍"
    default:
      return "❓"
  }
}
