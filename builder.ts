// Re-export types

const isBuildkite = Deno.env.get("BUILDKITE")

// Ensure we get the proper types from the implementations
let selectedBuilder: typeof import("~/builder/buildkite/mod.ts")
export let mode: string

if (isBuildkite) {
  selectedBuilder = await import("~/builder/buildkite/mod.ts")
  mode = "buildkite"
} else {
  selectedBuilder = await import("~/builder/local.ts")
  mode = "local"
}

// Re-export everything with proper typing
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
  group,
} = selectedBuilder
