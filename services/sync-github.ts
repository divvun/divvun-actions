// deno-lint-ignore-file no-console

export type SyncGithubProps = {
  buildkite: {
    apiKey?: string
    orgName?: string
  }
  github: {
    apiKey?: string
    orgs?: {
      name: string
      repoPattern?: RegExp
    }[]
  }
}

function parseNextLinkHeader(linkHeader: string | null) {
  if (!linkHeader) {
    return null
  }

  const linksArray = linkHeader.split(",").map((link) => {
    let [url, rel] = link.split(";").map((part) => part.trim())
    url = url.slice(1, -1)
    rel = rel.split("=")[1].slice(1, -1)
    return { url, rel }
  })

  const nextLink = linksArray.find((link) => link.rel === "next")
  if (!nextLink) {
    return null
  }

  return nextLink.url
}

type GithubRepo = {
  name: string
  description: string | null
  url: string
  topics: string[]
  private: boolean
  archived: boolean
  created_at: string
  updated_at: string
  pushed_at: string
  default_branch: string
}

async function listGithubRepos(props: Required<SyncGithubProps["github"]>) {
  let responses: any[] = []
  for (const org of props.orgs) {
    const repos = await listGithubReposForOrg(props, org.name)
    responses = [...responses, ...repos]
  }
  return responses.map((repo) => ({
    name: repo.full_name,
    description: repo.description,
    url: repo.html_url,
    topics: repo.topics || [],
    private: repo.private,
    archived: repo.archived,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    default_branch: repo.default_branch,
  }))
}

async function listGithubReposForOrg(
  props: Required<SyncGithubProps["github"]>,
  orgName: string,
) {
  let nextUrl: string | null =
    `https://api.github.com/orgs/${orgName}/repos?per_page=100`
  let responses: any[] = []

  while (nextUrl != null) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${props.apiKey}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    const data = await response.json()
    responses = [...responses, ...data]

    nextUrl = parseNextLinkHeader(response.headers.get("link"))
  }

  return responses
}

type BuildkitePipeline = {
  id: string
  name: string
  slug: string
  tags: string[]
  url: string
  webhook_url: string
  repository: string
  created_at: string
  updated_at: string
  archived_at: string | null
  default_branch: string
  visibility: string
  configuration: string
  branch_configuration: string | null
  skip_queued_branch_builds?: boolean
  skip_queued_branch_builds_filter?: string | null
  filter_enabled?: boolean
  filter_condition?: string | null
  provider: {
    settings: {
      build_tags?: boolean
    }
  }
}

type GithubWebhook = {
  id: number
  name: string
  active: boolean
  events: string[]
  config: {
    url: string
    content_type: string
    insecure_ssl?: string
  }
  updated_at: string
  created_at: string
}

type GithubRelease = {
  tag_name: string
  name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  created_at: string
}

type PackageChannels = {
  stable?: string
  beta?: string
  dev?: string
}

type StatusEntry = {
  maturity: string
  packages?: Record<string, PackageChannels>
}

async function listBuildkitePipelines(
  props: SyncGithubProps["buildkite"],
): Promise<BuildkitePipeline[]> {
  let nextUrl: string | null =
    `https://api.buildkite.com/v2/organizations/${props.orgName}/pipelines?per_page=100`
  let responses: any[] = []

  while (nextUrl != null) {
    console.log(`Fetching pipelines from ${nextUrl}`)
    const response = await fetch(
      nextUrl,
      {
        headers: {
          Authorization: `Bearer ${props.apiKey}`,
        },
      },
    )

    nextUrl = parseNextLinkHeader(response.headers.get("link"))
    const data = await response.json()
    responses = [...responses, ...data]
  }

  return responses.map((pipeline) => ({
    id: pipeline.id,
    name: pipeline.name,
    slug: pipeline.slug,
    tags: pipeline.tags || [],
    url: pipeline.web_url,
    webhook_url: pipeline.provider.webhook_url,
    repository: pipeline.repository,
    created_at: pipeline.created_at,
    updated_at: pipeline.updated_at,
    archived_at: pipeline.archived_at,
    default_branch: pipeline.default_branch,
    visibility: pipeline.visibility,
    configuration: pipeline.configuration,
    branch_configuration: pipeline.branch_configuration,
    skip_queued_branch_builds: pipeline.skip_queued_branch_builds,
    skip_queued_branch_builds_filter: pipeline.skip_queued_branch_builds_filter,
    provider: pipeline.provider,
  }))
}

const V_REGEX = /^# v: (.*)$/
const CUR_VERSION = 1

function extractMaturityTag(topics: string[]): string | null {
  const maturityTopic = topics.find((topic) => topic.startsWith("maturity-"))
  if (!maturityTopic) {
    return null
  }

  const maturityLevel = maturityTopic.split("-")[1]
  return `:package: ${maturityLevel}`
}

function extractMaturityValue(tags: string[]): string | null {
  const packageTag = tags.find((tag) => tag.startsWith(":package: "))
  if (!packageTag) {
    return null
  }

  return packageTag.split(" ")[1]
}

const PIPELINE_STEPS: string = `
# Managed by Divvun Actions -- DO NOT EDIT
# version: ${CUR_VERSION}
steps:
  - command: divvun-actions ci
    plugins:
    - ssh://git@github.com/divvun/divvun-actions.git#main: ~
`.trim()

async function listGithubWebhooks(
  props: Required<SyncGithubProps["github"]>,
  repoName: string,
): Promise<GithubWebhook[]> {
  const [owner, repo] = repoName.split("/")

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/hooks`,
    {
      headers: {
        Authorization: `Bearer ${props.apiKey}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  )

  if (!response.ok) {
    if (response.status === 404) {
      return []
    }
    throw new Error(
      `Failed to list webhooks for ${repoName}: ${response.status}`,
    )
  }

  const data = await response.json()
  return data.map((hook: any) => ({
    id: hook.id,
    name: hook.name,
    active: hook.active,
    events: hook.events,
    config: hook.config,
    updated_at: hook.updated_at,
    created_at: hook.created_at,
  }))
}

async function listGithubReleases(
  props: Required<SyncGithubProps["github"]>,
  repoName: string,
): Promise<GithubRelease[]> {
  const [owner, repo] = repoName.split("/")

  let nextUrl: string | null =
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`
  let releases: GithubRelease[] = []

  while (nextUrl != null) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${props.apiKey}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    if (!response.ok) {
      if (response.status === 404) {
        return []
      }
      throw new Error(
        `Failed to list releases for ${repoName}: ${response.status}`,
      )
    }

    const data = await response.json()
    releases = [
      ...releases,
      ...data.map((release: any) => ({
        tag_name: release.tag_name,
        name: release.name,
        draft: release.draft,
        prerelease: release.prerelease,
        published_at: release.published_at,
        created_at: release.created_at,
      })),
    ]

    nextUrl = parseNextLinkHeader(response.headers.get("link"))
  }

  return releases
}

function parseReleasesByPackage(
  releases: GithubRelease[],
): Record<string, PackageChannels> {
  const packages: Record<string, PackageChannels> = {}

  for (const release of releases) {
    // Handle dev-latest releases specially - extract version from release name
    if (release.tag_name.includes("dev-latest")) {
      // Release name format: "grammar-sma/v0.1.2-dev.20250111T123456Z+build.123"
      const nameMatch = release.name.match(/^(.+)\/v(.+)$/)
      if (nameMatch) {
        const packageName = nameMatch[1]
        const version = nameMatch[2]

        if (!packages[packageName]) {
          packages[packageName] = {}
        }

        const pkg = packages[packageName]
        if (!pkg.dev) {
          pkg.dev = version
        }
      }
      continue
    }

    const match = release.tag_name.match(/^(.+)\/v(.+)$/)

    if (!match) {
      continue
    }

    const packageName = match[1]
    const version = match[2]

    if (!packages[packageName]) {
      packages[packageName] = {}
    }

    const pkg = packages[packageName]

    if (release.prerelease && !pkg.beta) {
      pkg.beta = version
    } else if (!release.draft && !release.prerelease && !pkg.stable) {
      pkg.stable = version
    }
  }

  return packages
}

function hasWebhookForPipeline(
  webhooks: GithubWebhook[],
  pipeline: BuildkitePipeline,
): boolean {
  return webhooks.some((webhook) =>
    webhook.name === "web" &&
    webhook.active &&
    webhook.config.url === pipeline.webhook_url
  )
}

async function createBuildkiteWebhook(
  props: Required<SyncGithubProps["github"]>,
  repoName: string,
  pipeline: BuildkitePipeline,
): Promise<GithubWebhook> {
  const [owner, repo] = repoName.split("/")

  const payload = {
    name: "web",
    active: true,
    events: ["push"],
    config: {
      url: pipeline.webhook_url,
      content_type: "json",
      insecure_ssl: "0",
    },
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/hooks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${props.apiKey}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to create webhook for ${repoName}: ${response.status}`,
    )
  }

  const data = await response.json()
  return {
    id: data.id,
    name: data.name,
    active: data.active,
    events: data.events,
    config: data.config,
    updated_at: data.updated_at,
    created_at: data.created_at,
  }
}

// curl -H "Authorization: Bearer $TOKEN" \
//   -X POST "https://api.buildkite.com/v2/organizations/{org.slug}/pipelines" \
//   -H "Content-Type: application/json" \
//   -d '{
//       "name": "My Pipeline X",
//       "cluster_id": "xxx",
//       "repository": "git@github.com:acme-inc/my-pipeline.git",
//       "configuration": "env:\n \"FOO\": \"bar\"\nsteps:\n - command: \"script/release.sh\"\n   \"name\": \"Build 📦\""
//     }'
async function createBuildkitePipeline(
  props: SyncGithubProps["buildkite"],
  repo: any,
) {
  const response = await fetch(
    `https://api.buildkite.com/v2/organizations/${props.orgName}/pipelines`,
    {
      headers: {
        Authorization: `Bearer ${props.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({
        cluster_id: "6b73d337-bcdc-432b-9017-0767786acb3f",
        name: repo.name.split("/")[1],
        repository: `git@github.com:${repo.name}.git`,
        visibility: repo.private ? "private" : "public",
        configuration: PIPELINE_STEPS + "\n",
        branch_configuration: "!gh-pages",
      }),
    },
  )

  return await response.json()
}

async function updateBuildkitePipeline(
  props: SyncGithubProps["buildkite"],
  pipeline: BuildkitePipeline,
  updates:
    & Partial<
      Pick<
        BuildkitePipeline,
        | "branch_configuration"
        | "configuration"
        | "tags"
        | "skip_queued_branch_builds"
        | "skip_queued_branch_builds_filter"
        | "filter_enabled"
        | "filter_condition"
      >
    >
    & {
      provider_settings?: {
        build_tags?: boolean
      }
    },
) {
  const response = await fetch(
    `https://api.buildkite.com/v2/organizations/${props.orgName}/pipelines/${pipeline.slug}`,
    {
      headers: {
        Authorization: `Bearer ${props.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "PATCH",
      body: JSON.stringify(updates),
    },
  )

  if (!response.ok) {
    throw new Error(
      `Failed to update pipeline ${pipeline.name}: ${response.status}`,
    )
  }

  return await response.json()
}

function assessStatus(
  repo: GithubRepo,
  pipelines: BuildkitePipeline[],
  webhooks?: GithubWebhook[],
) {
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

  const discrepancies = []

  // Pipeline tags/topics comparison code removed for now
  // const pipelineTags = new Set(pipeline.tags)
  // const repoTopics = new Set(repo.topics)
  // if (pipelineTags.difference(repoTopics).size > 0) {
  //   discrepancies.push({
  //     code: "tags-mismatch",
  //     message: `Pipeline tags do not match repo topics`,
  //   })
  // }

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

// export default async function syncGithub(props: SyncGithubProps) {
//   console.log("Getting pipelines")
//   const pipelines = await listBuildkitePipelines(props.buildkite as Required<SyncGithubProps["buildkite"]>)

//   console.log("Getting repos")
//   const repos = await listGithubRepos(props.github as Required<SyncGithubProps["github"]>)

//   for (const repo of repos) {
//     const status = assessStatus(repo, pipelines)
//     if (status.discrepancies.find(x => x.code === "no-pipeline")) {
//       continue;
//     }
//     console.log(status)
//   }
//   // Check if repos are in sync

//   // // console.log(pipelines)
//   // // console.log(repos)

//   // const prodRepos = repos.filter(repo => {
//   //     return repo.topics.includes("maturity-prod")
//   // }).map(x => x.full_name).flat()

//   // console.log(prodRepos)

//   // const lol = await createBuildkitePipeline(
//   //   props.buildkite,
//   //   "giellalt",
//   //   "lang-fao",
//   // )
// }

function requiredArgs(required: string[], args: Record<string, unknown>) {
  for (const arg of required) {
    if (!args[arg]) {
      console.error(`Missing required argument: ${arg}`)
      Deno.exit(1)
    }
  }
}

if (import.meta.main) {
  const { parseArgs } = await import("@std/cli/parse-args")
  const args = parseArgs(Deno.args, {
    string: ["bk-key", "bk-org", "gh-key", "gh-orgs"],
    boolean: ["status"],
  })

  console.log("Parsed arguments:", args)

  const command = args._[0] as string
  const validCommands = ["list-repos", "list-pipelines", "sync"]

  if (!command || !validCommands.includes(command)) {
    console.error(
      `Missing or invalid command. Valid commands: ${validCommands.join(", ")}`,
    )
    Deno.exit(1)
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
    case "list-repos": {
      requiredArgs(["gh-key", "gh-orgs"], args)
      const repos = await listGithubRepos(
        props.github as Required<SyncGithubProps["github"]>,
      )
      console.log(JSON.stringify(repos, null, 2))
      break
    }
    case "list-pipelines": {
      console.log("Listing Buildkite pipelines...")
      requiredArgs(["bk-key", "bk-org"], args)
      const pipelines = await listBuildkitePipelines(
        props.buildkite as Required<SyncGithubProps["buildkite"]>,
      )
      console.log(JSON.stringify(pipelines, null, 2))
      break
    }
    case "sync": {
      requiredArgs(["bk-key", "bk-org", "gh-key", "gh-orgs"], args)
      await syncGithub(props, args.status)
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      Deno.exit(1)
  }
}

type SyncStatus = {
  repoName: string
  pipelineName: string | null
  inSync: boolean
  discrepancies: Array<{
    code: string
    message: string
  }>
  repo?: GithubRepo
  pipeline?: BuildkitePipeline
}

function prettyPrintSyncResults(results: SyncStatus[]) {
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

function getDiscrepancyIcon(code: string): string {
  switch (code) {
    case "no-pipeline":
      return "🚫"
    case "tags-mismatch":
      return "🏷️"
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
    default:
      return "❓"
  }
}

export default async function syncGithub(
  props: SyncGithubProps,
  writeStatus = false,
) {
  const githubProps = props.github as Required<SyncGithubProps["github"]>
  const buildkiteProps = props.buildkite as Required<
    SyncGithubProps["buildkite"]
  >

  console.log("🔍 Getting pipelines...")
  const pipelines = await listBuildkitePipelines(buildkiteProps)

  console.log("🔍 Getting repos...")
  const allRepos = await listGithubRepos(githubProps)
  const repos = allRepos.filter((repo) => {
    return repo.name.includes("lang-") || repo.name.includes("keyboard-")
  })

  console.log("🔄 Assessing sync status...")
  const results: SyncStatus[] = []

  const releasesByRepo: Record<string, Record<string, PackageChannels>> = {}

  for (const repo of repos) {
    console.log(`🔍 Checking webhooks for ${repo.name}...`)
    let webhooks: GithubWebhook[] = []
    try {
      webhooks = await listGithubWebhooks(githubProps, repo.name)
    } catch (error) {
      console.warn(`⚠️ Could not fetch webhooks for ${repo.name}: ${error}`)
    }

    console.log(`🔍 Checking releases for ${repo.name}...`)
    try {
      const releases = await listGithubReleases(githubProps, repo.name)
      const packages = parseReleasesByPackage(releases)
      releasesByRepo[repo.name] = packages
    } catch (error) {
      console.warn(`⚠️ Could not fetch releases for ${repo.name}: ${error}`)
      releasesByRepo[repo.name] = {}
    }

    const status = assessStatus(repo, pipelines, webhooks)
    results.push(status)
  }

  prettyPrintSyncResults(results)

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

  // Write status.json if requested
  if (writeStatus) {
    console.log(`📝 Writing status.json...`)
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
        "status.json",
        JSON.stringify(statusData, null, 2),
      )
      console.log(
        `✅ Wrote status for ${
          Object.keys(statusData).length
        } pipelines to status.json`,
      )
    } catch (error) {
      console.error(`❌ Failed to write status.json: ${error}`)
    }
  }
}
