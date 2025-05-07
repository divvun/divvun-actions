import * as path from "@std/path"

export const projectPath = path.resolve(
  path.dirname(path.fromFileUrl(import.meta.url)),
)

export const workingDir = Deno.env.get("_DIVVUN_ACTIONS_PWD")!
export const env = Deno.env.get("_DIVVUN_ACTIONS_ENV")!
export const platform = Deno.env.get("_DIVVUN_ACTIONS_PLATFORM")!
export const command = Deno.env.get("_DIVVUN_ACTIONS_COMMAND")

export let gitHash: string = "main"

try {
  const hash = await new Deno.Command("git", {
    args: ["rev-parse", "--short", "HEAD"],
    cwd: projectPath,
  }).output()

  if (hash.success) {
    const decoder = new TextDecoder()
    gitHash = decoder.decode(hash.stdout).trim()
  }
} catch (_) {
  // Ignore
}
