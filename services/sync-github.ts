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
  repository: string
  created_at: string
  updated_at: string
  archived_at: string | null
  default_branch: string
  visibility: string
  configuration: string
}

async function listBuildkitePipelines(
  props: SyncGithubProps["buildkite"],
): Promise<BuildkitePipeline[]> {
  let nextUrl: string | null =
    `https://api.buildkite.com/v2/organizations/${props.orgName}/pipelines`
  let responses: any[] = []

  while (nextUrl != null) {
    const response = await fetch(
      `https://api.buildkite.com/v2/organizations/${props.orgName}/pipelines`,
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
    repository: pipeline.repository,
    created_at: pipeline.created_at,
    updated_at: pipeline.updated_at,
    archived_at: pipeline.archived_at,
    default_branch: pipeline.default_branch,
    visibility: pipeline.visibility,
    configuration: pipeline.configuration,
  }))
}

const V_REGEX = /^# v: (.*)$/
const CUR_VERSION = 1

const PIPELINE_STEPS: string = `
# Managed by Divvun Actions -- DO NOT EDIT
# version: ${CUR_VERSION}
steps:
  - command: divvun-actions ci
    plugins:
    - ssh://git@github.com/divvun/divvun-actions.git#main: ~
`.trim()

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
      }),
    },
  )

  return await response.json()
}

function assessStatus(repo: GithubRepo, pipelines: BuildkitePipeline[]) {
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

  const pipelineTags = new Set(pipeline.tags)
  const repoTopics = new Set(repo.topics)

  const differences = pipelineTags.difference(repoTopics)
  const discrepancies = []

  // if (differences.size > 0) {
  //   discrepancies.push({
  //     code: "tags-mismatch",
  //     message: `Pipeline tags (${[...pipelineTags].join(", ")}) do not match repo topics (${[...repoTopics].join(", ")})`,
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
  })

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
      requiredArgs(["bk-key", "bk-org"], args)
      const pipelines = await listBuildkitePipelines(
        props.buildkite as Required<SyncGithubProps["buildkite"]>,
      )
      console.log(JSON.stringify(pipelines, null, 2))
      break
    }
    case "sync": {
      requiredArgs(["bk-key", "bk-org", "gh-key", "gh-orgs"], args)
      await syncGithub(props)
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
    default:
      return "❓"
  }
}

export default async function syncGithub(props: SyncGithubProps) {
  console.log("🔍 Getting pipelines...")
  const pipelines = await listBuildkitePipelines(
    props.buildkite as Required<SyncGithubProps["buildkite"]>,
  )

  console.log("🔍 Getting repos...")
  const allRepos = await listGithubRepos(
    props.github as Required<SyncGithubProps["github"]>,
  )
  const repos = allRepos.filter((repo) => {
    return repo.name.includes("lang-") || repo.name.includes("keyboard-")
  })

  console.log("🔄 Assessing sync status...")
  const results: SyncStatus[] = []

  for (const repo of repos) {
    const status = assessStatus(repo, pipelines)
    // if (status.discrepancies.find(x => x.code === "no-pipeline")) {
    //   continue;
    // }
    results.push(status)
  }

  prettyPrintSyncResults(results)

  const noPipelines = results.filter((r) =>
    r.discrepancies.some((d) => d.code === "no-pipeline")
  )

  for (const result of noPipelines) {
    console.log(`🚀 Creating pipeline for ${result.repoName}...`)
    const newPipeline = await createBuildkitePipeline(
      props.buildkite,
      result.repo,
    )
    console.log(`✅ Created pipeline: ${newPipeline.name} (${newPipeline.url})`)
  }
}
