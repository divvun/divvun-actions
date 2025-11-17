import type { DiscrepancyCode, SyncStatus } from "./types.ts"

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

  console.log(`\n📊 Sync Status Summary`)
  console.log(`${"=".repeat(50)}`)
  console.log(`✅ In sync: ${inSyncCount}`)
  console.log(`❌ Out of sync: ${outOfSyncCount}`)
  console.log(`📦 Total repositories: ${results.length}`)
  console.log()

  // Group results by sync status
  const inSync = results.filter((r) => r.inSync)
  const outOfSync = results.filter((r) => !r.inSync)

  if (inSync.length > 0) {
    console.log(`✅ Repositories in sync:`)
    console.log(`${"─".repeat(30)}`)
    for (const result of inSync) {
      console.log(`  📁 ${result.repoName}`)
      if (result.pipelineName) {
        console.log(`     🔧 Pipeline: ${result.pipelineName}`)
      }
    }
    console.log()
  }

  if (outOfSync.length > 0) {
    console.log(`❌ Repositories out of sync:`)
    console.log(`${"─".repeat(35)}`)
    for (const result of outOfSync) {
      console.log(`  📁 ${result.repoName}`)
      if (result.pipelineName) {
        console.log(`     🔧 Pipeline: ${result.pipelineName}`)
      } else {
        console.log(`     🔧 Pipeline: None`)
      }

      for (const discrepancy of result.discrepancies) {
        const icon = getDiscrepancyIcon(discrepancy.code)
        console.log(`     ${icon} ${discrepancy.message}`)
      }
      console.log()
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
