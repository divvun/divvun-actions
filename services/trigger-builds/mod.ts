import { homedir } from "node:os"
import * as path from "@std/path"
import logger from "~/util/log.ts"
import { ExpectedError } from "~/util/error.ts"
import { fetchBuildkite } from "~/services/sync-github/api.ts"
import { listBuildkitePipelines } from "~/services/sync-github/buildkite-client.ts"
import type { BuildkitePipeline } from "~/services/sync-github/types.ts"

export const API_TOKEN_VARIABLE = "BUILDKITE_API_TOKEN"
export const API_TOKEN_FILE = "~/.buildkite-token"

/**
 * The Buildkite API token: BUILDKITE_API_TOKEN if it is set, or else the
 * contents of ~/.buildkite-token, or nothing when neither holds one.
 */
export async function apiToken(home = homedir()): Promise<string | undefined> {
  const fromEnv = Deno.env.get(API_TOKEN_VARIABLE)?.trim()
  if (fromEnv) return fromEnv
  try {
    const file = path.join(home, ".buildkite-token")
    return (await Deno.readTextFile(file)).trim() || undefined
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined
    throw e
  }
}

export type TriggerOptions = {
  pattern: RegExp
  org: string
  /** The branch every pipeline builds; absent, each builds its own default. */
  branch?: string
  message: string
  /** List the builds that would be triggered, and trigger none. */
  dryRun: boolean
  /** Trigger without asking first. */
  yes: boolean
}

export type BuildRequest = {
  pipeline: string
  branch: string
}

export type TriggeredBuild = BuildRequest & {
  number: number
  url: string
}

/** The pipelines whose slug the pattern matches, leaving out archived ones. */
export function matchingPipelines(
  pipelines: readonly BuildkitePipeline[],
  pattern: RegExp,
): BuildkitePipeline[] {
  return pipelines.filter((pipeline) => {
    pattern.lastIndex = 0
    return pipeline.archived_at == null && pattern.test(pipeline.slug)
  })
}

/** The build to request of each pipeline, on `branch` or its default. */
export function buildRequests(
  pipelines: readonly BuildkitePipeline[],
  branch?: string,
): BuildRequest[] {
  return pipelines.map((pipeline) => {
    const target = branch ?? pipeline.default_branch
    if (!target) {
      throw ExpectedError.create(
        `${pipeline.slug} has no default branch: pass --branch`,
      )
    }
    return { pipeline: pipeline.slug, branch: target }
  })
}

/** Starts a build of the head of the request's branch. */
export async function triggerBuild(
  request: BuildRequest,
  { token, org, message }: { token: string; org: string; message: string },
): Promise<TriggeredBuild> {
  const response = await fetchBuildkite(
    `https://api.buildkite.com/v2/organizations/${
      encodeURIComponent(org)
    }/pipelines/${encodeURIComponent(request.pipeline)}/builds`,
    token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commit: "HEAD",
        branch: request.branch,
        message,
      }),
    },
  )
  const build = await response.json()
  return { ...request, number: build.number, url: build.web_url }
}

export async function runTrigger(
  options: TriggerOptions,
  token?: string,
): Promise<TriggeredBuild[]> {
  token ??= await apiToken()
  if (!token) {
    throw ExpectedError.create(
      `Set ${API_TOKEN_VARIABLE}, or write ${API_TOKEN_FILE}, to a Buildkite ` +
        "API access token with the read_pipelines and write_builds scopes",
    )
  }

  const pipelines = await listBuildkitePipelines({
    apiKey: token,
    orgName: options.org,
  })
  const requests = buildRequests(
    matchingPipelines(pipelines, options.pattern),
    options.branch,
  )
  if (requests.length === 0) {
    logger.info(`No pipeline in ${options.org} matches ${options.pattern}`)
    return []
  }

  logger.info(`${requests.length} pipelines match ${options.pattern}:`)
  for (const { pipeline, branch } of requests) {
    logger.info(`  ${pipeline} (${branch})`)
  }
  if (options.dryRun) return []
  if (!options.yes && !confirm(`Trigger ${requests.length} builds?`)) {
    logger.info("Triggered nothing")
    return []
  }

  const triggered: TriggeredBuild[] = []
  const failed: string[] = []
  for (const request of requests) {
    try {
      const build = await triggerBuild(request, {
        token,
        org: options.org,
        message: options.message,
      })
      logger.info(`${build.pipeline} #${build.number}: ${build.url}`)
      triggered.push(build)
    } catch (e) {
      logger.error(`${request.pipeline}: ${(e as Error).message}`)
      failed.push(request.pipeline)
    }
  }
  if (failed.length > 0) {
    throw ExpectedError.create(
      `Triggered ${triggered.length} of ${requests.length} builds; ` +
        `these failed: ${failed.join(", ")}`,
    )
  }
  return triggered
}
