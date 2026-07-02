import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { bumpChartImageTag } from "~/util/k8s-config.ts"

/** CD for a divvun worker: build the repo's Dockerfile on push to main, push
 * `:latest` + `:sha-<commit>`, then pin the sha tag in the worker's chart
 * values.yaml in k8s-config. One worker binary serves every channel (channels
 * differ only in data); the ApplicationSets defer to the chart default, so one
 * bump rolls all channels at once, replacing mutable `latest`. */
export type WorkerCd = {
  /** Repo/binary name, e.g. "divvun-worker-grammar". Doubles as the cli
   * command prefix (`<name>-deploy`, `<name>-bump-manifest`), the ghcr image
   * name, and the Buildkite metadata key. */
  name: string
  /** Path within k8s-config to the chart values.yaml that pins the image. */
  chartValuesPath: string
}

export const DIVVUN_WORKER_GRAMMAR: WorkerCd = {
  name: "divvun-worker-grammar",
  chartValuesPath: "charts/grammar-language/values.yaml",
}

export const DIVVUN_WORKER_SPELLER: WorkerCd = {
  name: "divvun-worker-speller",
  chartValuesPath: "charts/speller-language/values.yaml",
}

function image(cd: WorkerCd): string {
  return `ghcr.io/divvun/${cd.name}`
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineWorkerCd(cd: WorkerCd): BuildkitePipeline {
  return {
    steps: [
      command({
        key: "build-push",
        label: "Build & Push",
        command: `divvun-actions run ${cd.name}-deploy`,
        agents: { queue: "linux" },
        branches: "main",
      }),
      command({
        label: "Bump k8s chart",
        command: `divvun-actions run ${cd.name}-bump-manifest`,
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "build-push",
      }),
    ],
  }
}

export async function runWorkerCdDeploy(cd: WorkerCd) {
  const tag = `sha-${builder.env.commit}`

  await builder.exec("docker", [
    "build",
    "-t",
    `${image(cd)}:latest`,
    "-t",
    `${image(cd)}:${tag}`,
    ".",
  ])

  await builder.group("Pushing image", async () => {
    await Promise.all([
      builder.exec("docker", ["push", `${image(cd)}:latest`]),
      builder.exec("docker", ["push", `${image(cd)}:${tag}`]),
    ])
  })

  await builder.setMetadata(`${cd.name}-tag`, tag)
}

export async function runWorkerCdBumpManifest(cd: WorkerCd) {
  const tag = (await builder.metadata(`${cd.name}-tag`)).trim()
  if (tag.length === 0) {
    throw new Error(`Buildkite metadata ${cd.name}-tag was empty`)
  }

  await bumpChartImageTag({
    imageName: image(cd),
    tag,
    valuesPath: cd.chartValuesPath,
    imageKey: "workerImage",
    commitMessage: `Update ${cd.name} image to ${tag}`,
  })
}
