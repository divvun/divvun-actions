if (!Deno.env.get("BUILDKITE")) {
  throw new Error("divvun-actions only runs in a Buildkite job")
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
