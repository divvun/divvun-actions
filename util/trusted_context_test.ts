import { equal, ok, throws } from "node:assert/strict"
import type { Env } from "~/util/env.ts"
import {
  isPullRequest,
  isTrustedBranch,
  isTrustedReleaseContext,
  isTrustedTag,
  requireTrustedReleaseContext,
  trustedReleaseMode,
} from "~/util/trusted_context.ts"

function environment(overrides: Partial<Env> = {}): Env {
  return {
    jobId: undefined,
    groupId: undefined,
    groupKey: undefined,
    buildId: undefined,
    buildNumber: undefined,
    buildTimestamp: "2026-10-31T00:00:00Z",
    agentId: undefined,
    agentMetaData: {},
    artifactUploadDestination: undefined,
    branch: "main",
    tag: undefined,
    message: undefined,
    commit: "0123456789abcdef",
    pipelineSlug: "test",
    pipelineName: "test",
    pipelineId: "test",
    pipelineProvider: "github",
    organizationSlug: "divvun",
    triggeredFromBuildPipelineSlug: undefined,
    repo: "git@github.com:divvun/example.git",
    repoName: "example",
    repoPath: "divvun/example",
    repoHost: "github.com",
    repoProtocol: "ssh",
    pullRequest: "false",
    pullRequestBaseBranch: undefined,
    pullRequestRepo: undefined,
    config: null,
    ...overrides,
  }
}

Deno.test("trusted context rejects pull requests even when branch or tag looks trusted", () => {
  for (const tag of [undefined, "v1.2.3", "speller-sme/v1.2.3"]) {
    const env = environment({ pullRequest: "42", tag })
    equal(isTrustedBranch(env, ["main", "v4"]), false)
    equal(isTrustedTag(env), false)
    equal(isTrustedReleaseContext(env), false)
    equal(trustedReleaseMode(env), null)
    throws(
      () => requireTrustedReleaseContext(env, "access CI secrets"),
      Error,
      "Refusing to access CI secrets",
    )
  }
})

Deno.test("trusted context accepts only protected branches and strict release tags", () => {
  equal(isPullRequest(environment()), false)
  equal(trustedReleaseMode(environment()), "dev")
  equal(
    trustedReleaseMode(environment({ branch: "feature" })),
    null,
  )
  equal(
    trustedReleaseMode(environment({ branch: "feature", tag: "v1.2.3" })),
    "release",
  )
  equal(
    trustedReleaseMode(
      environment({ branch: "feature", tag: "speller-sme/v1.2.3-rc.1" }),
    ),
    "release",
  )
  equal(isTrustedTag(environment({ tag: "vgarbage" })), false)
  equal(isTrustedTag(environment({ tag: "v01.2.3" })), false)
  equal(isTrustedTag(environment({ tag: "v1.2.3-01" })), false)
  equal(
    isTrustedReleaseContext(environment({ repoHost: "example.com" })),
    false,
  )
  equal(isTrustedReleaseContext(environment({ repoPath: "example" })), false)
  equal(isTrustedReleaseContext(environment()), false)
  ok(isTrustedReleaseContext(environment({ repoPath: "divvun/box" })))
  ok(
    isTrustedReleaseContext(environment({ repoPath: "giellalt/lang-sme" })),
  )
  equal(
    isTrustedReleaseContext(environment({ repoPath: "divvun/unrecognized" })),
    false,
  )
  equal(
    isTrustedReleaseContext(
      environment({ branch: "v4", repoPath: "divvun/box" }),
    ),
    false,
  )
  ok(
    isTrustedReleaseContext(
      environment({ branch: "v4", repoPath: "divvun/kbdgen" }),
    ),
  )
})
