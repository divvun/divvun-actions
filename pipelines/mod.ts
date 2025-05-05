import * as yaml from "@std/yaml"
import {
  type Agents,
  type BlockStep,
  type BuildkitePipeline,
  type CommandStep,
  type GroupStep,
  type InputStep,
  parsePipelineFile,
  type Step,
  type TriggerStep,
  validatePipeline,
  type WaitStep,
} from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import type { DivvunActionsConfig } from "~/util/config.ts"
import Docker from "~/util/docker.ts"
import logger from "~/util/log.ts"
import Tart from "~/util/tart.ts"

export type PipelineName = "divvunspell"

type StepHandlers<T> = {
  command?: (step: CommandStep) => T
  block?: (step: BlockStep) => T
  wait?: (step: WaitStep) => T
  trigger?: (step: TriggerStep) => T
  group?: (step: GroupStep) => T
  input?: (step: InputStep) => T
  _?: (step: Step) => T
}

export function matchStep<T>(step: Step, handlers: StepHandlers<T>): T {
  if ("command" in step && handlers.command) {
    return handlers.command(step as CommandStep)
  }
  if ("block" in step && handlers.block) {
    return handlers.block(step as BlockStep)
  }
  if ("wait" in step && handlers.wait) {
    return handlers.wait(step as WaitStep)
  }
  if ("trigger" in step && handlers.trigger) {
    return handlers.trigger(step as TriggerStep)
  }
  if ("group" in step && handlers.group) {
    return handlers.group(step as GroupStep)
  }
  if ("input" in step && handlers.input) {
    return handlers.input(step as InputStep)
  }
  if (handlers._) {
    return handlers._(step)
  }
  throw new Error(`Unhandled step type: ${JSON.stringify(step)}`)
}

function parseAgents(agents: Agents | undefined) {
  if (agents == null) {
    return {}
  }

  if (Array.isArray(agents)) {
    return agents.reduce((acc, agent) => {
      const [k, v] = agent.split("=", 1)
      acc[k] = v
      return acc
    }, {} as Record<string, string>)
  }

  return agents
}

export async function runLocalPipeline(
  config: DivvunActionsConfig,
  pipelineInput: BuildkitePipeline | string,
) {
  let pipeline: BuildkitePipeline
  if (typeof pipelineInput === "string") {
    pipeline = await parsePipelineFile(pipelineInput)
  } else {
    pipeline = validatePipeline(pipelineInput)
  }

  for (const step of pipeline.steps) {
    await matchStep(step, {
      command: async (step) => {
        const agents = parseAgents(step.agents)

        if (!["macos", "windows", "linux"].includes(agents.platform)) {
          throw new Error(`Unsupported platform: ${agents.platform}`)
        }

        const platform = agents.platform as "macos" | "windows" | "linux"

        if (agents.platform === "macos") {
          // await Tart.exec
        } else {
          const host = config.targets?.[platform]?.remote
          await Docker.exec(step, {
            workingDir: Deno.cwd(),
            platform: agents.platform,
            host,
          })
        }
        // console.log(step);
        // await enterEnvironment(undefined, "linux", "./artifacts", async () => {
        //   const proc = new Deno.Command("bash", {
        //     args: ["-c", step.command as string],
        //     cwd: target.workingDir,
        //   });
        //   const status = await proc.spawn().status;
        //   if (status.code !== 0) {
        //     throw new Error(`Process exited with code ${status.code}`);
        //   }
        // });
      },
    })
  }
}

async function enterEnvironment(
  config: DivvunActionsConfig | undefined,
  platform: string,
  artifactsDir: string,
  callback: () => Promise<void>,
) {
  const workingDir = target.workingDir
  let id: string | undefined = undefined

  try {
    switch (platform) {
      case "macos": {
        if (Deno.build.os === "darwin") {
          const isInVirtualMachine = Tart.isInVirtualMachine()

          if (!isInVirtualMachine) {
            await Tart.enterVirtualMachine(
              config?.targets?.macos,
              workingDir,
              artifactsDir,
            )
            return
          }

          id = await Tart.enterWorkspace()
        } else {
          throw new Error(`Unsupported platform: ${platform}`)
        }
        break
      }
      case "linux":
      case "windows": {
        console.log("hi, uh")
        const isInContainer = await Docker.isInContainer()
        console.log("isInContainer", isInContainer)

        if (!isInContainer) {
          logger.info(`Working directory: ${workingDir}`)
          logger.info("Entering Docker container environment...")
          await Docker.enterEnvironment("divvun-actions", workingDir)
          return
        } else {
          id = await Docker.enterWorkspace()
        }
        break
      }
      default:
        logger.error(`Unsupported platform: ${platform}`)
        Deno.exit(1)
    }
  } catch (e) {
    console.log("error", e)
  }

  try {
    await callback()
  } catch (e) {
    logger.error(e)
  }

  switch (platform) {
    case "macos": {
      if (id) {
        await Tart.exitWorkspace(id)
      }
      break
    }
    case "linux":
    case "windows": {
      if (id) {
        await Docker.exitWorkspace(id)
      }
      break
    }
  }
}

export function generatePipeline<
  T extends "yaml" | "json" | undefined = undefined,
>(
  name: PipelineName,
  options: Record<string, any>,
  format?: T,
): T extends "yaml" | "json" ? string : BuildkitePipeline {
  let pipeline: BuildkitePipeline

  switch (name) {
    case "divvunspell":
      // pipeline = divvunspellPipeline(options as any)
      break
    default:
      throw new Error(`Unknown pipeline: ${name}`)
  }

  let output: T extends "yaml" | "json" ? string : BuildkitePipeline

  switch (format) {
    case "yaml":
      output = yaml.stringify(pipeline, { indent: 2 }) as typeof output
      break
    case "json":
      output = JSON.stringify(pipeline, null, 2) as typeof output
      break
    default:
      output = pipeline as typeof output
      break
  }

  return output
}

export default generatePipeline
