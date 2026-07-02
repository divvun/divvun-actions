import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { bumpChartImageTag } from "~/util/k8s-config.ts"

const IMAGE = "ghcr.io/divvun/divvun-worker-grammar"
// One worker binary serves every channel (channels differ only in data). All
// grammar ApplicationSets defer to the chart default, so pinning the tag here —
// a plain values.yaml — rolls every channel at once, replacing mutable `latest`.
const CHART_VALUES_PATH = "charts/grammar-language/values.yaml"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineDivvunWorkerGrammar(): BuildkitePipeline {
  return {
    steps: [
      command({
        key: "build-push",
        label: "Build & Push",
        command: "divvun-actions run divvun-worker-grammar-deploy",
        agents: { queue: "linux" },
        branches: "main",
      }),
      command({
        label: "Bump k8s ApplicationSet",
        command: "divvun-actions run divvun-worker-grammar-bump-manifest",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "build-push",
      }),
    ],
  }
}

export async function runDivvunWorkerGrammarDeploy() {
  const tag = `sha-${builder.env.commit}`

  // The repo's multi-stage Dockerfile builds the binary internally (./x build).
  await builder.exec("docker", [
    "build",
    "-t",
    `${IMAGE}:latest`,
    "-t",
    `${IMAGE}:${tag}`,
    ".",
  ])

  await builder.group("Pushing image", async () => {
    await Promise.all([
      builder.exec("docker", ["push", `${IMAGE}:latest`]),
      builder.exec("docker", ["push", `${IMAGE}:${tag}`]),
    ])
  })

  await builder.setMetadata("divvun-worker-grammar-tag", tag)
}

export async function runDivvunWorkerGrammarBumpManifest() {
  const tag = (await builder.metadata("divvun-worker-grammar-tag")).trim()
  if (tag.length === 0) {
    throw new Error("Buildkite metadata divvun-worker-grammar-tag was empty")
  }

  await bumpChartImageTag({
    imageName: IMAGE,
    tag,
    valuesPath: CHART_VALUES_PATH,
    imageKey: "workerImage",
    commitMessage: `Update divvun-worker-grammar image to ${tag}`,
  })
}
