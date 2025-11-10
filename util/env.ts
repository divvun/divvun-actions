import { memoize } from "@std/cache"

function metadata(prefix: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key in Deno.env) {
    if (key.startsWith(`${prefix}_AGENT_META_DATA_`)) {
      const name = key.replace(`${prefix}_AGENT_META_DATA_`, "")
      const value = Deno.env.get(key)
      if (value != null) {
        env[name] = value
      }
    }
  }
  return env
}

function parseBuildkiteUrl(url: string) {
  url = url.replace(/\.git$/, "")
  if (url.startsWith("git@")) {
    return new URL(`ssh://${url.replace(":", "/")}`)
  }
  return new URL(url)
}

function parseConfigFromEnv() {
  const raw = Deno.env.get(`BUILDKITE_PLUGINS`)

  if (raw == null) {
    return null
  }

  const parsed = JSON.parse(raw) as Array<Record<string, { config?: unknown }>>

  for (const plugin of parsed) {
    for (const key in plugin) {
      if (key.startsWith("ssh://git@github.com/divvun/divvun-actions.git")) {
        return plugin[key]?.config as Record<string, unknown> ?? null
      }
    }
  }

  return null
}

const env = (prefix: string): Env => {
  const repo = Deno.env.get(`${prefix}_REPO`) ?? ""
  const repoUrl = parseBuildkiteUrl(repo)
  const repoProtocol = repoUrl.protocol.replace(/:$/, "")
  const repoHost = repoUrl.host
  const repoPath = repoUrl.pathname.replace(/^\//, "")
  const repoName = repoPath.split("/").pop()!
  const config = parseConfigFromEnv()
  const agentMetaData = metadata(prefix)
  const buildTimestamp = agentMetaData["BUILD_TIMESTAMP"] ?? new Date().toISOString()

  return {
    jobId: Deno.env.get(`${prefix}_JOB_ID`),
    groupId: Deno.env.get(`${prefix}_GROUP_ID`),
    groupKey: Deno.env.get(`${prefix}_GROUP_KEY`),
    buildId: Deno.env.get(`${prefix}_BUILD_ID`),
    buildNumber: Deno.env.get(`${prefix}_BUILD_NUMBER`),
    agentId: Deno.env.get(`${prefix}_AGENT_ID`),
    agentMetaData,
    buildTimestamp,
    artifactUploadDestination: Deno.env.get(
      `${prefix}_ARTIFACT_UPLOAD_DESTINATION`,
    ),
    branch: Deno.env.get(`${prefix}_BRANCH`),
    tag: Deno.env.get(`${prefix}_TAG`),
    message: Deno.env.get(`${prefix}_MESSAGE`),
    commit: Deno.env.get(`${prefix}_COMMIT`),
    pipelineSlug: Deno.env.get(`${prefix}_PIPELINE_SLUG`),
    pipelineName: Deno.env.get(`${prefix}_PIPELINE_NAME`),
    pipelineId: Deno.env.get(`${prefix}_PIPELINE_ID`),
    pipelineProvider: Deno.env.get(`${prefix}_PIPELINE_PROVIDER`),
    organizationSlug: Deno.env.get(`${prefix}_ORGANIZATION_SLUG`),
    triggeredFromBuildPipelineSlug: Deno.env.get(
      `${prefix}_TRIGGERED_FROM_BUILD_PIPELINE_SLUG`,
    ),
    repo,
    repoPath,
    repoHost,
    repoName,
    repoProtocol,
    pullRequest: Deno.env.get(`${prefix}_PULL_REQUEST`),
    pullRequestBaseBranch: Deno.env.get(
      `${prefix}_PULL_REQUEST_BASE_BRANCH`,
    ),
    pullRequestRepo: Deno.env.get(`${prefix}_PULL_REQUEST_REPO`),
    config,
  }
}

export type Env = {
  jobId: string | undefined
  groupId: string | undefined
  groupKey: string | undefined
  buildId: string | undefined
  buildNumber: string | undefined
  agentId: string | undefined
  agentMetaData: Record<string, string>
  buildTimestamp: string
  artifactUploadDestination: string | undefined
  branch: string | undefined
  tag: string | undefined
  message: string | undefined
  commit: string | undefined
  pipelineSlug: string | undefined
  pipelineName: string | undefined
  pipelineId: string | undefined
  pipelineProvider: string | undefined
  organizationSlug: string | undefined
  triggeredFromBuildPipelineSlug: string | undefined
  repo: string
  repoName: string
  repoPath: string
  repoHost: string
  repoProtocol: string
  pullRequest: string | undefined
  pullRequestBaseBranch: string | undefined
  pullRequestRepo: string | undefined
  config: Record<string, unknown> | Error | null
}

export const buildkite = memoize(() => env("BUILDKITE"))
export const local = memoize(() => env("LOCAL"))
