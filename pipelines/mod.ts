// deno-lint-ignore-file no-console
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
