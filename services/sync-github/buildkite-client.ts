import { parseNextLinkHeader } from "./utils.ts"
import {
  BUILDKITE_CLUSTER_ID,
  type BuildkitePipeline,
  PIPELINE_STEPS,
  type SyncGithubProps,
} from "./types.ts"

export async function listBuildkitePipelines(
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

export async function createBuildkitePipeline(
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
        cluster_id: BUILDKITE_CLUSTER_ID,
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

export async function updateBuildkitePipeline(
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
