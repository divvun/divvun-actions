import { deepStrictEqual, equal, ok } from "node:assert/strict"
import type { BuildkitePipeline } from "~/builder/pipeline.ts"
import type { Env } from "~/util/env.ts"
import {
  commandRequiresTrustedContext,
  isPrivilegedPipelineAction,
  securePipelineForContext,
} from "~/util/privileged_action.ts"

const env = {
  branch: "main",
  tag: undefined,
  pullRequest: "42",
  repoHost: "github.com",
  repoPath: "divvun/box",
} satisfies Pick<
  Env,
  "branch" | "tag" | "pullRequest" | "repoHost" | "repoPath"
>

Deno.test("privileged action classification is fail-closed for mutations and signing", () => {
  for (
    const action of [
      "box-publish",
      "lang-proofing-deploy",
      "teaksta-bump-manifest",
      "macos-sign",
      "donate-speech-build-ios",
    ]
  ) {
    ok(isPrivilegedPipelineAction(action), action)
  }
  ok(
    isPrivilegedPipelineAction("divvun-actions-build-image", ["linux", "push"]),
  )
  equal(
    isPrivilegedPipelineAction("divvun-actions-build-image", [
      "linux",
      "no-push",
    ]),
    false,
  )
  equal(isPrivilegedPipelineAction("lang-speller-test"), false)
  ok(commandRequiresTrustedContext("divvun-actions sign app.exe"))
  ok(commandRequiresTrustedContext("divvun-actions run box-publish"))
  equal(commandRequiresTrustedContext("cargo test --all"), false)
})

Deno.test("untrusted pipelines retain builds and tests but omit privileged groups and steps", () => {
  const pipeline: BuildkitePipeline = {
    steps: [
      { key: "test", command: "cargo test --all" },
      {
        group: "release",
        steps: [
          {
            key: "sign",
            command: ["download artifact", "divvun-actions sign app.exe"],
          },
          { key: "publish", command: "divvun-actions run box-publish" },
        ],
      },
      {
        key: "unsigned-package",
        depends_on: "sign",
        command: "package --unsigned",
      },
      { key: "deploy", command: "divvun-actions run borealium-deploy" },
    ],
  }

  deepStrictEqual(securePipelineForContext(pipeline, env), {
    steps: [
      { key: "test", command: "cargo test --all" },
      {
        key: "unsigned-package",
        command: "package --unsigned",
      },
    ],
  })
  equal(
    securePipelineForContext(pipeline, { ...env, pullRequest: "false" }),
    pipeline,
  )
})
