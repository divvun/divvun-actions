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

export type GithubRepo = {
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

export type BuildkitePipeline = {
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

export type GithubWebhook = {
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

export type GithubRelease = {
  id: number
  tag_name: string
  name: string
  draft: boolean
  prerelease: boolean
  published_at: string
  created_at: string
}

export type PackageChannels = {
  stable?: string
  beta?: string
  dev?: string
}

export type StatusEntry = {
  maturity: string
  packages?: Record<string, PackageChannels>
}

export type DiscrepancyCode =
  | "no-pipeline"
  | "version-mismatch"
  | "undeclared-configuration"
  | "no-webhook"
  | "branch-configuration-missing"
  | "tags-not-enabled"
  | "skip-queued-not-enabled"
  | "filter-not-set"
  | "maturity-tags-mismatch"

export type SyncStatus = {
  repoName: string
  pipelineName: string | null
  inSync: boolean
  discrepancies: {
    code: DiscrepancyCode
    message: string
  }[]
  repo: GithubRepo
  pipeline?: BuildkitePipeline
}

// Constants
export const V_REGEX = /^# v: (.*)$/
export const CUR_VERSION = 1
export const BUILDKITE_CLUSTER_ID = "6b73d337-bcdc-432b-9017-0767786acb3f"

export const PIPELINE_STEPS: string = `
# Managed by Divvun Actions -- DO NOT EDIT
# version: ${CUR_VERSION}
steps:
  - command: divvun-actions ci
    plugins:
    - ssh://git@github.com/divvun/divvun-actions.git#main: ~
`.trim()
