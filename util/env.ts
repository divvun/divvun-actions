import { memoize } from "@std/cache"
import * as toml from "@std/toml"
import * as yaml from "@std/yaml"

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

const PLUGIN_PREFIX = "BUILDKITE_PLUGIN_DIVVUN_ACTIONS_GIT"

function parseConfigFromEnv() {
  const configType: string | undefined = Deno.env.get(`${PLUGIN_PREFIX}_TYPE`)
  const config = Deno.env.get(`${PLUGIN_PREFIX}_CONFIG`)

  if (config == null) {
    return null
  }

  try {
    if (configType === "json" || configType == null) {
      return JSON.parse(config) as Record<string, unknown>
    }

    if (configType === "yaml" || configType === "yml") {
      return yaml.parse(config) as Record<string, unknown>
    }

    if (configType === "toml") {
      const tomlData = toml.parse(config) as Record<string, unknown>
      return tomlData
    }
  } catch (e: unknown) {
    if (e instanceof Error) {
      return e
    }
    return new Error("Unknown error parsing config", { cause: e })
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

  return {
    jobId: Deno.env.get(`${prefix}_JOB_ID`),
    groupId: Deno.env.get(`${prefix}_GROUP_ID`),
    groupKey: Deno.env.get(`${prefix}_GROUP_KEY`),
    buildId: Deno.env.get(`${prefix}_BUILD_ID`),
    buildNumber: Deno.env.get(`${prefix}_BUILD_NUMBER`),
    agentId: Deno.env.get(`${prefix}_AGENT_ID`),
    agentMetaData: metadata(prefix),
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
