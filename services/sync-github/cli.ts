// deno-lint-ignore-file no-console
import { parseArgs } from "@std/cli/parse-args"
import { pooledMap } from "@std/async/pool"
import { requiredArgs } from "./utils.ts"
import {
  deleteGithubRelease,
  isDevLatestRelease,
  listGithubReleases,
  listGithubRepos,
} from "./github-client.ts"
import { listBuildkitePipelines } from "./buildkite-client.ts"
import { getStatus, syncAndFix, writeStatusJson } from "./core.ts"
import { prettyPrintSyncResults } from "./formatters.ts"
import { parseReleasesByPackage } from "./release-parser.ts"
import type { PackageChannels, SyncGithubProps } from "./types.ts"

function showHelp() {
  console.log(`
Sync GitHub repositories with Buildkite pipelines

USAGE:
  deno run services/sync-github/cli.ts <COMMAND> [OPTIONS]

COMMANDS:
  status              Check sync status without making changes
  sync                Full sync with auto-fixes
  list-repos          List all GitHub repositories
  list-pipelines      List all Buildkite pipelines
  clear-dev-releases  Delete all dev-latest releases across all repos
  help                Show this help message

OPTIONS:
  --bk-key <key>         Buildkite API key (required for most commands)
  --bk-org <org>         Buildkite organization name (required for most commands)
  --gh-key <key>         GitHub API key (required for most commands)
  --gh-orgs <orgs>       Comma-separated list of GitHub orgs (required for most commands)
  --output <path>        Write status.json to specified path (optional, for status command)
  --dry-run              Preview changes without making them (for clear-dev-releases)

EXAMPLES:
  # Check sync status (read-only)
  deno run services/sync-github/cli.ts status \\
    --bk-key=\${BK_TOKEN} --bk-org=divvun \\
    --gh-key=\${GH_TOKEN} --gh-orgs=divvun,giellalt

  # Check status and write status.json
  deno run services/sync-github/cli.ts status \\
    --bk-key=\${BK_TOKEN} --bk-org=divvun \\
    --gh-key=\${GH_TOKEN} --gh-orgs=divvun,giellalt \\
    --output=status.json

  # Full sync with auto-fixes
  deno run services/sync-github/cli.ts sync \\
    --bk-key=\${BK_TOKEN} --bk-org=divvun \\
    --gh-key=\${GH_TOKEN} --gh-orgs=divvun,giellalt

  # List GitHub repositories
  deno run services/sync-github/cli.ts list-repos \\
    --gh-key=\${GH_TOKEN} --gh-orgs=divvun,giellalt

  # List Buildkite pipelines
  deno run services/sync-github/cli.ts list-pipelines \\
    --bk-key=\${BK_TOKEN} --bk-org=divvun

  # Preview dev-latest releases that would be deleted
  deno run services/sync-github/cli.ts clear-dev-releases \\
    --gh-key=\${GH_TOKEN} --gh-orgs=divvun,giellalt --dry-run

  # Delete all dev-latest releases
  deno run services/sync-github/cli.ts clear-dev-releases \\
    --gh-key=\${GH_TOKEN} --gh-orgs=divvun,giellalt
`)
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["bk-key", "bk-org", "gh-key", "gh-orgs", "output"],
    boolean: ["help", "dry-run"],
  })

  const command = args._[0] as string
  const validCommands = [
    "status",
    "sync",
    "list-repos",
    "list-pipelines",
    "clear-dev-releases",
    "help",
  ]

  if (!command || !validCommands.includes(command) || args.help) {
    showHelp()
    Deno.exit(command === "help" ? 0 : 1)
  }

  const props: SyncGithubProps = {
    buildkite: {
      apiKey: args["bk-key"],
      orgName: args["bk-org"],
    },
    github: {
      apiKey: args["gh-key"],
      orgs: args["gh-orgs"]?.split(",").map((org) => ({
        name: org,
      })),
    },
  }

  switch (command) {
    case "status": {
      requiredArgs(["bk-key", "bk-org", "gh-key", "gh-orgs"], args)
      const results = await getStatus(props)
      prettyPrintSyncResults(results)

      if (args.output) {
        const githubProps = props.github as Required<SyncGithubProps["github"]>
        const releasesByRepo: Record<string, Record<string, PackageChannels>> =
          {}

        console.log("\n🔍 Fetching releases for status.json...")
        for await (
          const { repoName, packages } of pooledMap(
            5,
            results,
            async (result) => {
              console.log(`🔍 Checking releases for ${result.repoName}...`)
              try {
                const releases = await listGithubReleases(
                  githubProps,
                  result.repoName,
                )
                const packages = parseReleasesByPackage(releases)
                return { repoName: result.repoName, packages }
              } catch (error) {
                console.warn(
                  `⚠️ Could not fetch releases for ${result.repoName}: ${error}`,
                )
                return { repoName: result.repoName, packages: {} }
              }
            },
          )
        ) {
          releasesByRepo[repoName] = packages
        }

        await writeStatusJson(results, releasesByRepo, args.output)
      }
      break
    }

    case "sync": {
      requiredArgs(["bk-key", "bk-org", "gh-key", "gh-orgs"], args)
      await syncAndFix(props)
      break
    }

    case "list-repos": {
      requiredArgs(["gh-key", "gh-orgs"], args)
      const githubProps = props.github as Required<SyncGithubProps["github"]>
      const repos = await listGithubRepos(githubProps)
      console.log(`\n📦 Found ${repos.length} repositories:\n`)
      for (const repo of repos) {
        console.log(`  📁 ${repo.name}`)
        if (repo.description) {
          console.log(`     ${repo.description}`)
        }
        if (repo.topics.length > 0) {
          console.log(`     🏷️  ${repo.topics.join(", ")}`)
        }
        console.log()
      }
      break
    }

    case "list-pipelines": {
      requiredArgs(["bk-key", "bk-org"], args)
      const buildkiteProps = props.buildkite as Required<
        SyncGithubProps["buildkite"]
      >
      const pipelines = await listBuildkitePipelines(buildkiteProps)
      console.log(`\n🔧 Found ${pipelines.length} pipelines:\n`)
      for (const pipeline of pipelines) {
        console.log(`  🔨 ${pipeline.name} (${pipeline.slug})`)
        console.log(`     ${pipeline.url}`)
        if (pipeline.tags.length > 0) {
          console.log(`     🏷️  ${pipeline.tags.join(", ")}`)
        }
        console.log()
      }
      break
    }

    case "clear-dev-releases": {
      requiredArgs(["gh-key", "gh-orgs"], args)
      const githubProps = props.github as Required<SyncGithubProps["github"]>
      const dryRun = args["dry-run"]

      console.log(
        `\n${dryRun ? "[DRY RUN] " : ""}Clearing dev-latest releases...\n`,
      )

      const repos = await listGithubRepos(githubProps)
      console.log(`Found ${repos.length} repositories to check\n`)

      let totalDeleted = 0
      let totalFound = 0

      for await (
        const { repoName, releases, deleted } of pooledMap(
          5,
          repos,
          async (repo) => {
            try {
              const releases = await listGithubReleases(githubProps, repo.name)
              const devReleases = releases.filter((r) =>
                isDevLatestRelease(r.tag_name)
              )

              if (devReleases.length === 0) {
                return { repoName: repo.name, releases: [], deleted: 0 }
              }

              if (!dryRun) {
                for (const release of devReleases) {
                  await deleteGithubRelease(githubProps, repo.name, release.id)
                }
              }

              return {
                repoName: repo.name,
                releases: devReleases,
                deleted: devReleases.length,
              }
            } catch (error) {
              console.warn(`  Warning: Could not process ${repo.name}: ${error}`)
              return { repoName: repo.name, releases: [], deleted: 0 }
            }
          },
        )
      ) {
        if (releases.length > 0) {
          console.log(`${repoName}:`)
          for (const release of releases) {
            console.log(
              `  ${dryRun ? "[would delete]" : "[deleted]"} ${release.tag_name}`,
            )
          }
          totalFound += releases.length
          totalDeleted += deleted
        }
      }

      console.log(`\n${dryRun ? "[DRY RUN] " : ""}Summary:`)
      console.log(`  Total dev-latest releases found: ${totalFound}`)
      if (!dryRun) {
        console.log(`  Total releases deleted: ${totalDeleted}`)
      } else {
        console.log(`  Run without --dry-run to delete these releases`)
      }
      break
    }

    default: {
      console.error(`Unknown command: ${command}`)
      showHelp()
      Deno.exit(1)
    }
  }
}
