// Re-export types
import type {
  Context,
  ExecListeners,
  ExecOptions,
  InputOptions,
} from "./builder/types.ts"

const isBuildkite = Deno.env.get("BUILDKITE")

// Ensure we get the proper types from the implementations
let selectedBuilder: typeof import("~/builder/local.ts")
export let mode: string

if (isBuildkite) {
  selectedBuilder = await import("~/builder/buildkite.ts")
  mode = "buildkite"
} else {
  selectedBuilder = await import("~/builder/local.ts")
  mode = "local"
}

// Re-export everything with proper typing
export const {
  exec,
  spawn,
  addPath,
  redactSecret,
  getInput,
  setOutput,
  context,
  secrets,
  tempDir,
  createArtifact,
  setMaxLines,
  group,
} = selectedBuilder

// Re-export types
export type { Context, ExecListeners, ExecOptions, InputOptions }
