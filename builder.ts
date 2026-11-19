import { isBuildkiteJob } from "~/util/env.ts"

if (!isBuildkiteJob()) {
  throw new Error(
    "builder.ts only loads in a Buildkite job: BUILDKITE is not set",
  )
}

const buildkite = await import("~/builder/buildkite/mod.ts")

export const {
  exec,
  output,
  addPath,
  redactSecret,
  setMetadata,
  metadata,
  uploadArtifacts,
  downloadArtifacts,
  env,
  secrets,
  ciKey,
  pahkatUploadToken,
  group,
} = buildkite
