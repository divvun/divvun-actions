import { pooledMap } from "@std/async/pool"
import { parseNextLinkHeader } from "./utils.ts"
import { fetchGithub } from "./api.ts"
import type {
  BuildkitePipeline,
  GithubRelease,
  GithubRepo,
  GithubWebhook,
  SyncGithubProps,
} from "./types.ts"

export async function listGithubRepos(
  props: Required<SyncGithubProps["github"]>,
): Promise<GithubRepo[]> {
  const allRepos: any[] = []
  for await (
    const repos of pooledMap(
      3,
      props.orgs,
      (org) => listGithubReposForOrg(props, org.name),
    )
  ) {
    allRepos.push(...repos)
  }
  return allRepos.map((repo) => ({
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
    const response = await fetchGithub(nextUrl, props.apiKey, {
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    const data = await response.json()
    responses = [...responses, ...data]

    nextUrl = parseNextLinkHeader(response.headers.get("link"))
  }

  return responses
}

export async function listGithubWebhooks(
  props: Required<SyncGithubProps["github"]>,
  repoName: string,
): Promise<GithubWebhook[]> {
  const [owner, repo] = repoName.split("/")

  const response = await fetchGithub(
    `https://api.github.com/repos/${owner}/${repo}/hooks`,
    props.apiKey,
    {
      headers: {
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

export async function listGithubReleases(
  props: Required<SyncGithubProps["github"]>,
  repoName: string,
): Promise<GithubRelease[]> {
  const [owner, repo] = repoName.split("/")

  let nextUrl: string | null =
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`
  let releases: GithubRelease[] = []

  while (nextUrl != null) {
    const response = await fetchGithub(nextUrl, props.apiKey, {
      headers: {
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

export async function createBuildkiteWebhook(
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

  const response = await fetchGithub(
    `https://api.github.com/repos/${owner}/${repo}/hooks`,
    props.apiKey,
    {
      method: "POST",
      headers: {
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

export function hasWebhookForPipeline(
  webhooks: GithubWebhook[],
  pipeline: BuildkitePipeline,
): boolean {
  return webhooks.some((webhook) =>
    webhook.name === "web" &&
    webhook.active &&
    webhook.config.url === pipeline.webhook_url
  )
}
