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

const env = (prefix: string): Env => {
  return {
    get jobId() {
      return Deno.env.get(`${prefix}_JOB_ID`)
    },
    get groupId() {
      return Deno.env.get(`${prefix}_GROUP_ID`)
    },
    get groupKey() {
      return Deno.env.get(`${prefix}_GROUP_KEY`)
    },
    get buildId() {
      return Deno.env.get(`${prefix}_BUILD_ID`)
    },
    get buildNumber() {
      return Deno.env.get(`${prefix}_BUILD_NUMBER`) 
    },
    get agentId() {
      return Deno.env.get(`${prefix}_AGENT_ID`)
    },
    get agentMetaData() {
      return metadata(prefix)
    },
    get artifactUploadDestination() {
      return Deno.env.get(`${prefix}_ARTIFACT_UPLOAD_DESTINATION`)
    },
    get branch() {
      return Deno.env.get(`${prefix}_BRANCH`)
    },
    get tag() {
      return Deno.env.get(`${prefix}_TAG`)
    },
    get message() {
      return Deno.env.get(`${prefix}_MESSAGE`) 
    },
    get commit() {
      return Deno.env.get(`${prefix}_COMMIT`)
    },
    get pipelineSlug() {
      return Deno.env.get(`${prefix}_PIPELINE_SLUG`)
    },
    get pipelineName() {
      return Deno.env.get(`${prefix}_PIPELINE_NAME`)
    },
    get pipelineId() {
      return Deno.env.get(`${prefix}_PIPELINE_ID`)
    },
    get pipelineProvider() {
      return Deno.env.get(`${prefix}_PIPELINE_PROVIDER`)
    },
    get organizationSlug() {
      return Deno.env.get(`${prefix}_ORGANIZATION_SLUG`)
    },
    get triggeredFromBuildPipelineSlug() {
      return Deno.env.get(`${prefix}_TRIGGERED_FROM_BUILD_PIPELINE_SLUG`)
    },
    get repo() {
      return Deno.env.get(`${prefix}_REPO`)!
    },
    get repoName() {
      const repo = Deno.env.get(`${prefix}_REPO`)!
      const repoName = (repo.split("/").pop() ?? "").split(".").shift() ?? ""
      return repoName
    },
    get pullRequest() {
      return Deno.env.get(`${prefix}_PULL_REQUEST`)
    },
    get pullRequestBaseBranch() {
      return Deno.env.get(`${prefix}_PULL_REQUEST_BASE_BRANCH`)
    },
    get pullRequestRepo() {
      return Deno.env.get(`${prefix}_PULL_REQUEST_REPO`)
    },
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
  pullRequest: string | undefined
  pullRequestBaseBranch: string | undefined
  pullRequestRepo: string | undefined
}

export const buildkite = memoize(() => env("BUILDKITE"))
export const local = memoize(() => env("LOCAL"))
