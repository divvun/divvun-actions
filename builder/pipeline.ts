import * as path from "@std/path"
import * as yaml from "@std/yaml"
import { Ajv } from "ajv"
import * as emoji from "emoji"
import pipelineSchema from "./schema.json" with { "type": "json" }

/**
 * A pipeline configuration for Buildkite. Pipelines contain a sequence of steps that are executed sequentially or in parallel.
 * Each step is executed on one or more agents, and can contain conditional logic to control when they execute.
 * @example
 * {
 *   env: {
 *     "FOO": "bar"
 *   },
 *   steps: [
 *     {
 *       command: "echo hello world"
 *     }
 *   ]
 * }
 */
export type BuildkitePipeline = {
  /**
   * Environment variables that will be made available to all steps in this pipeline.
   * @example
   * {
   *   "FOO": "bar",
   *   "BAR": "baz"
   * }
   */
  env?: Record<string, string>
  /**
   * Agent query rules that will be applied to all steps in this pipeline.
   * @example ["queue=default"]
   * @example { queue: "default" }
   */
  agents?: Agents
  /**
   * Notification services to send build events to.
   * @example ["slack"]
   * @example [{ slack: "#deploys" }]
   */
  notify?: BuildNotification[]
  /** The sequence of steps to run in this pipeline */
  steps: Step[]
}

/**
 * Agent query rules are used to target specific agents for running steps. Rules can be specified as a list of strings
 * in the legacy format, or as an object of key/value query rules.
 */
export type Agents = AgentsObject | string[]

/**
 * Agent query rules specified as key/value pairs. The key is the meta-data field to query, and the value is the meta-data value to match.
 * All rules must match for an agent to be selected.
 */
export type AgentsObject = Record<string, string>

/**
 * A step in the pipeline. Steps can be commands to run, pipelines to trigger, groups of steps, or manual approval steps.
 */
export type Step =
  | BlockStep
  | InputStep
  | CommandStep
  | WaitStep
  | TriggerStep
  | GroupStep

export type StepMatch = {
  block?: () => Promise<void>
  input?: () => Promise<void>
  command?: () => Promise<void>
  wait?: () => Promise<void>
  trigger?: () => Promise<void>
  group?: () => Promise<void>
}

export function matchStep(step: Step, match: StepMatch) {
  // Check each step type and call corresponding match function if defined
  if ("command" in step) {
    return match.command?.()
  }

  if ("block" in step) {
    return match.block?.()
  }

  if ("input" in step) {
    return match.input?.()
  }

  if ("wait" in step) {
    return match.wait?.()
  }

  if ("trigger" in step) {
    return match.trigger?.()
  }

  if ("group" in step) {
    return match.group?.()
  }

  // Return empty promise if no match found
  return Promise.resolve()
}

/**
 * Properties that are available to all step types
 */
export type BaseStep = {
  /**
   * A unique identifier for the step. Used to reference the step from other steps when defining dependencies.
   * @pattern ^[a-zA-Z0-9_-]+$
   * @example "tests"
   * @example "deploy-prod"
   */
  key?: string
  /**
   * A boolean expression that controls whether this step should run. Supports groups, conditions and pattern matching.
   * @example "build.message =~ /feature/"
   * @example "build.branch == 'main'"
   */
  if?: string
  /**
   * Steps that must complete before this step runs. Each value can be a step key, or an object specifying the step key and whether its failure can be ignored.
   * @example ["tests", "lint"]
   * @example [{ step: "tests", allow_failure: true }]
   */
  depends_on?: string | (string | { step: string; allow_failure?: boolean })[]
  /**
   * Whether to continue running when dependencies fail. If true, the step will run even if its dependencies fail.
   * @default false
   */
  allow_dependency_failure?: boolean
  /**
   * Pattern matching rules that control which Git branches this step can run on.
   * @example "main"
   * @example ["main", "release/*"]
   */
  branches?: string | string[]
}

/**
 * A step that blocks the pipeline until manually unblocked. When unblocked, any fields that were collected are made
 * available to subsequent steps as environment variables.
 * @example
 * {
 *   block: ":rocket: Release",
 *   fields: [
 *     {
 *       text: "Release Notes",
 *       key: "RELEASE_NOTES"
 *     }
 *   ]
 * }
 */
export type BlockStep = BaseStep & {
  /**
   * The label to show in the pipeline visualisation.
   * @example ":rocket: Release"
   */
  block: string
  /**
   * The state to show in the pipeline visualisation while blocked.
   * @default "running"
   * @example "running"
   */
  blocked_state?: "passed" | "failed" | "running"
  /**
   * Input fields to collect when unblocking.
   * @example [{ "text": "Release Notes", "key": "RELEASE_NOTES" }]
   */
  fields?: Field[]
  /**
   * Additional information to show when blocked.
   * @example "Ensure all tests have passed before releasing"
   */
  prompt?: string
}

/**
 * A field that can be used to collect information in block and input steps
 */
export type Field = TextField | SelectField

/**
 * A text input field that collects free-form text input.
 * @example
 * {
 *   text: "Release Notes",
 *   key: "RELEASE_NOTES",
 *   required: true,
 *   hint: "List the changes in this release"
 * }
 */
export type TextField = {
  /**
   * The label to show with the field.
   * @example "Release Notes"
   */
  text?: string
  /**
   * A unique identifier for the field. Used to generate the environment variable name.
   * @pattern ^[A-Z0-9_]+$
   * @example "RELEASE_NOTES"
   */
  key: string
  /**
   * Additional information to show with the field.
   * @example "List the changes in this release"
   */
  hint?: string
  /**
   * A regular expression that the value must match.
   * @example "^v[0-9]+\\.[0-9]+\\.[0-9]+$"
   */
  format?: string
  /**
   * Whether a value must be provided when submitted.
   * @default false
   */
  required?: boolean
  /**
   * The initial value for the field.
   * @example "v1.2.3"
   */
  default?: string
}

/**
 * A select input field that collects one or more values from a list of options.
 * @example
 * {
 *   select: "Environment",
 *   key: "ENVIRONMENT",
 *   options: [
 *     { label: "Staging", value: "staging" },
 *     { label: "Production", value: "production" }
 *   ],
 *   required: true
 * }
 */
export type SelectField = {
  /**
   * The label to show with the field.
   * @example "Environment"
   */
  select?: string
  /**
   * A unique identifier for the field. Used to generate the environment variable name.
   * @pattern ^[A-Z0-9_]+$
   * @example "ENVIRONMENT"
   */
  key: string
  /**
   * The list of options that can be selected.
   * @example [
   *   { "label": "Staging", "value": "staging" },
   *   { "label": "Production", "value": "production" }
   * ]
   */
  options: SelectOption[]
  /**
   * Whether multiple options can be selected.
   * @default false
   */
  multiple?: boolean
  /**
   * The initial value(s) for the field.
   * @example "staging"
   * @example ["staging", "production"]
   */
  default?: string | string[]
  /**
   * Additional information to show with the field.
   * @example "Select the environment to deploy to"
   */
  hint?: string
  /**
   * Whether a value must be provided when submitted.
   * @default false
   */
  required?: boolean
}

/**
 * An option that can be selected in a select field.
 * @example
 * {
 *   label: "Production",
 *   value: "production",
 *   hint: "Deploy to production servers"
 * }
 */
export type SelectOption = {
  /**
   * The label to show for the option.
   * @example "Production"
   */
  label: string
  /**
   * The value to submit when the option is selected.
   * @example "production"
   */
  value: string
  /**
   * Additional information to show with the option.
   * @example "Deploy to production servers"
   */
  hint?: string
}

/**
 * A step that runs one or more commands on an agent
 */
export type CommandStep = BaseStep & {
  /**
   * Command(s) to run on the agent. Each command is run in sequence.
   * @example "echo hello world"
   * @example ["echo hello", "echo world"]
   */
  command?: string | string[]
  /**
   * The label to show in the pipeline visualisation.
   * @example ":docker: Build"
   */
  label?: string
  /**
   * Agent query rules that control which agents can run this step.
   * @example ["queue=default"]
   * @example { queue: "default" }
   */
  agents?: Agents
  /**
   * Paths or patterns of artifacts to upload after the command finishes.
   *
   * (A heavy asterisk ('✱') is used to represent a wildcard character in the example below,
   * due to TSDoc limitations)
   *
   * @example "tmp/artifacts/✱✱/✱"
   * @example ["coverage/✱✱/✱", "tmp/artifacts/✱✱/✱"]
   */
  artifact_paths?: string | string[]
  /**
   * Maximum time (in minutes) the command can run for before being terminated.
   * @minimum 1
   * @default 60
   */
  timeout_in_minutes?: number
  /** Environment variables to pass to the command */
  env?: Record<string, string>
  /**
   * Buildkite plugins to use with this step.
   * @example ["docker#v1.0.0"]
   * @example [{"docker#v1.0.0": { "image": "node" }}]
   */
  plugins?: (string | Record<string, unknown>)[]
  /**
   * The number of parallel jobs to run. If greater than 1, the command will be run multiple times in parallel.
   * @minimum 1
   */
  parallelism?: number
  /**
   * Maximum number of jobs to run at once across all instances of this step.
   * @minimum 1
   */
  concurrency?: number
  /** Identifier for the concurrency group. Multiple steps with the same concurrency_group will share the concurrency limit */
  concurrency_group?: string
  /**
   * How to handle concurrency limits. "ordered" will run jobs in order, "eager" will run jobs as soon as slots are available.
   * @default "ordered"
   */
  concurrency_method?: "ordered" | "eager"
  /** Configuration for matrix builds. Allows running the command with different combinations of environment variables */
  matrix?: MatrixConfig
  /** Rules for automatically and manually retrying the command when it fails */
  retry?: RetryConfig
  /** Whether to skip running this step. Can be a boolean or a string containing a reason */
  skip?: boolean | string
  /** Whether to continue running when the command fails. Can be a boolean or a list of exit status codes to handle as soft failures */
  soft_fail?: boolean | SoftFailConfig[]
}

/**
 * Configuration for matrix builds. Allows running commands with different combinations of environment variables.
 * @example
 * {
 *   setup: {
 *     node: ["14", "16", "18"],
 *     os: ["linux", "windows"]
 *   },
 *   adjustments: [
 *     {
 *       with: { node: "14", os: "windows" },
 *       skip: true
 *     }
 *   ]
 * }
 */
export type MatrixConfig =
  | MatrixElement[]
  | {
    /** Matrix dimensions to generate combinations from */
    setup: MatrixElement[] | Record<string, MatrixElement[]>
    /** Rules for adjusting specific combinations */
    adjustments?: MatrixAdjustment[]
  }

/** A value that can be used in a matrix dimension */
export type MatrixElement = string | number | boolean

/**
 * A rule for adjusting specific combinations in a matrix build.
 * @example
 * {
 *   with: { node: "14", os: "windows" },
 *   skip: "Windows + Node 14 not supported",
 *   soft_fail: [{ exit_status: 1 }]
 * }
 */
export type MatrixAdjustment = {
  /** Values that identify the combinations to adjust */
  with: MatrixElement[] | Record<string, string>
  /** Whether to skip running these combinations */
  skip?: boolean | string
  /** Whether to continue when these combinations fail */
  soft_fail?: boolean | SoftFailConfig[]
}

/**
 * Configuration for retrying commands when they fail.
 * @example
 * {
 *   automatic: {
 *     exit_status: "*",
 *     limit: 2
 *   },
 *   manual: {
 *     allowed: true,
 *     reason: "Infrastructure issues"
 *   }
 * }
 */
export type RetryConfig = {
  /**
   * Rules for automatically retrying the command.
   * @example true
   * @example { exit_status: [1, 255], limit: 3 }
   */
  automatic?: boolean | AutomaticRetry | AutomaticRetry[]
  /**
   * Rules for allowing manual retries through the UI.
   * @example true
   * @example { allowed: true, reason: "Flaky tests" }
   */
  manual?: boolean | ManualRetry
}

/**
 * Rules for automatically retrying a command.
 * @example
 * {
 *   exit_status: "*",
 *   limit: 3,
 *   signal: "SIGTERM",
 *   signal_reason: "Agent disconnected"
 * }
 */
export type AutomaticRetry = {
  /**
   * Exit status code(s) to retry on.
   * @example "*"
   * @example [1, 255]
   */
  exit_status?: "*" | number | number[]
  /**
   * Maximum number of retry attempts.
   * @minimum 1
   * @default 2
   */
  limit?: number
  /** Signal that triggered the retry */
  signal?: string
  /** Reason for retrying on the signal */
  signal_reason?: string
}

/**
 * Rules for manually retrying a command through the UI.
 * @example
 * {
 *   allowed: true,
 *   permit_on_passed: false,
 *   reason: "Flaky test suite"
 * }
 */
export type ManualRetry = {
  /** Whether manual retries are permitted */
  allowed?: boolean
  /** Whether to allow retrying even if the command passed */
  permit_on_passed?: boolean
  /** Reason for allowing manual retries */
  reason?: string
}

/**
 * Configuration for handling specific exit status codes as soft failures.
 * @example { exit_status: "*" }
 * @example { exit_status: 1 }
 */
export type SoftFailConfig = {
  /** Exit status code to handle as a soft failure. Can be "*" to handle any failure */
  exit_status: "*" | number
}

/**
 * A step that waits for all previous steps to complete before continuing.
 * @example
 * {
 *   wait: null
 * }
 * @example
 * {
 *   wait: "Deploy approval received",
 *   continue_on_failure: true
 * }
 */
export type WaitStep = BaseStep & {
  /**
   * Optional name for the wait step.
   * @example null
   * @example "Wait for tests"
   */
  wait?: string | null
  /**
   * Whether to continue if previous steps failed.
   * @default false
   */
  continue_on_failure?: boolean
}

/**
 * A step that triggers another pipeline to run.
 * @example
 * {
 *   trigger: "deploy",
 *   build: {
 *     branch: "main",
 *     env: {
 *       DEPLOY_ENV: "production"
 *     }
 *   }
 * }
 */
export type TriggerStep = BaseStep & {
  /**
   * The pipeline to trigger.
   * @pattern ^[\w-]+$
   */
  trigger: string
  /** Configuration for the triggered build */
  build?: {
    /** The Git branch to build */
    branch?: string
    /** The Git commit to build */
    commit?: string
    /** Environment variables to pass to the build */
    env?: Record<string, string>
    /** Message to use for the build */
    message?: string
    /** Meta-data to pass to the build */
    meta_data?: Record<string, unknown>
  }
  /**
   * Whether to continue without waiting for the triggered build to complete.
   * @default false
   */
  async?: boolean
  /** The label to show in the pipeline visualisation */
  label?: string
}

/**
 * A step that groups several steps together.
 * @example
 * {
 *   group: "Tests",
 *   steps: [
 *     { command: "npm run test:unit" },
 *     { command: "npm run test:integration" }
 *   ]
 * }
 */
export type GroupStep = BaseStep & {
  /**
   * Name of the group.
   * @example "Tests"
   */
  group: string | null
  /** Steps to run in the group */
  steps: Step[]
}

/**
 * A step that prompts for input before continuing.
 * @example
 * {
 *   input: "Release Details",
 *   fields: [
 *     {
 *       text: "Version",
 *       key: "VERSION",
 *       required: true
 *     },
 *     {
 *       select: "Environment",
 *       key: "ENV",
 *       options: [
 *         { label: "Staging", value: "staging" },
 *         { label: "Production", value: "prod" }
 *       ]
 *     }
 *   ]
 * }
 */
export type InputStep = BaseStep & {
  /**
   * The label to show in the pipeline visualisation.
   * @example "Release Details"
   */
  input: string
  /**
   * Input fields to collect.
   * @example [
   *   {
   *     text: "Version",
   *     key: "VERSION",
   *     required: true
   *   }
   * ]
   */
  fields?: Field[]
  /**
   * Additional information to show when prompting.
   * @example "Please enter the release details"
   */
  prompt?: string
}

/**
 * Configuration for build notifications.
 * @example "github_check"
 * @example { slack: "#deploys" }
 * @example {
 *   slack: {
 *     channels: ["#deploys", "#alerts"],
 *     message: "Build {{status}}"
 *   }
 * }
 */
export type BuildNotification =
  | "github_check"
  | "github_commit_status"
  | { email: string; if?: string }
  | { basecamp_campfire: string; if?: string }
  | { slack: string | { channels: string[]; message: string }; if?: string }
  | { webhook: string; if?: string }
  | { pagerduty_change_event: string; if?: string }
  | { github_commit_status: { context: string }; if?: string }
  | { github_check: Record<string, unknown> }

export function validatePipeline(
  pipeline: BuildkitePipeline,
): BuildkitePipeline {
  const ajv = new Ajv()
  if (!ajv.validate(pipelineSchema, pipeline)) {
    console.log(ajv.errors)
    console.log(pipeline)
    throw new Error(ajv.errorsText())
  }
  return pipeline
}

export async function parsePipelineFile(
  filePath: string,
): Promise<BuildkitePipeline> {
  const ext = path.extname(filePath)
  const text = emoji.emojify(await Deno.readTextFile(filePath))

  let data: unknown
  switch (ext) {
    case ".yml":
    case ".yaml":
      data = yaml.parse(text)
      break
    case ".json":
      data = JSON.parse(text)
      break
    default:
      throw new Error(`Unsupported file type: ${ext}`)
  }

  const ajv = new Ajv()
  if (!ajv.validate(pipelineSchema, data)) {
    throw new Error(ajv.errorsText())
  }

  return data as BuildkitePipeline
}
