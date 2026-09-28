import * as builder from "~/builder.ts"
import * as target from "~/target.ts"
import {
  IMAGE_BUILT_FILE,
  INSTALLED_TOOLS_FILE,
} from "~/util/image_manifest.ts"
import logger from "~/util/log.ts"

/** The tools a lang build's results depend on, and how each reports its version. */
const TOOL_VERSIONS: { name: string; cmd: string; args: string[] }[] = [
  { name: "hfst", cmd: "/opt/divvun/bin/hfst", args: ["--version"] },
  { name: "cg3", cmd: "/opt/divvun/bin/vislcg3", args: ["--version"] },
  { name: "foma", cmd: "/opt/divvun/bin/foma", args: ["-v"] },
  { name: "divvunspell", cmd: "divvunspell", args: ["--version"] },
  { name: "divvun-runtime", cmd: "divvun-runtime", args: ["--version"] },
]

async function firstLine(cmd: string, args: string[]): Promise<string> {
  try {
    const out = await new Deno.Command(cmd, {
      args,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(10_000),
    }).output()
    const text = new TextDecoder().decode(out.stdout).trim() ||
      new TextDecoder().decode(out.stderr).trim()
    return text.split("\n")[0] || `(no output, exit ${out.code})`
  } catch (e) {
    return e instanceof Deno.errors.NotFound
      ? "not installed"
      : `(failed: ${e instanceof Error ? e.message : String(e)})`
  }
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(file)).trim()
  } catch {
    return null
  }
}

/**
 * Log which divvun-actions, build, agent, image and tool builds this job runs
 * with. `--version` alone cannot tell dev-latest builds apart, so the image's
 * record of the release assets it installed is printed too.
 */
export async function logJobEnvironment(): Promise<void> {
  await builder.group("Environment", async () => {
    const env = builder.env
    logger.info(`divvun-actions: ${target.gitHash}`)
    logger.info(
      `Build: ${env.pipelineSlug ?? "?"} #${env.buildNumber ?? "?"}, ` +
        `branch ${env.branch ?? "?"}, commit ${env.commit ?? "?"}`,
    )
    logger.info(
      `Agent: ${Deno.env.get("BUILDKITE_AGENT_NAME") ?? "?"} ` +
        `(queue ${env.agentMetaData?.queue ?? "?"}) on ${Deno.hostname()}`,
    )

    const built = await readOrNull(IMAGE_BUILT_FILE)
    logger.info(
      `Image built: ${built ?? "not recorded (image predates the stamp)"}`,
    )

    const installed = await readOrNull(INSTALLED_TOOLS_FILE)
    if (installed) {
      logger.info("Installed from:")
      for (const line of installed.split("\n")) {
        const [name, url] = line.split(" ")
        logger.info(`  ${name}: ${url?.split("/").pop() ?? "?"}`)
      }
    } else {
      logger.info("Installed from: not recorded (image predates the record)")
    }

    logger.info("Versions:")
    logger.info(`  deno: ${Deno.version.deno}`)
    for (const tool of TOOL_VERSIONS) {
      logger.info(`  ${tool.name}: ${await firstLine(tool.cmd, tool.args)}`)
    }
  })
}
