const provider = Deno.env.get("BUILDKITE") ? "buildkite" : null

if (!provider) {
  throw new Error("No supported CI provider detected")
}

let selectedBuilder: typeof import("~/builder/buildkite/mod.ts")

switch (provider) {
  case "buildkite":
    selectedBuilder = await import("~/builder/buildkite/mod.ts")
    break
}

export const mode = provider

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
