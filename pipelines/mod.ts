import {
  type BlockStep,
  type CommandStep,
  type GroupStep,
  type InputStep,
  type Step,
  type TriggerStep,
  type WaitStep,
} from "~/builder/pipeline.ts"

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
