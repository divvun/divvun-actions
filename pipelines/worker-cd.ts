import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { bumpChartImageTag } from "~/util/k8s-config.ts"

/** CD for a divvun worker, following the channel model the language data packs
 * already use:
 *
 * - push to main   → build+push `:sha-<commit>` → bump the unstable pin
 * - push tag vX.Y.Z → build+push `:vX.Y.Z` (and `:sha-<commit>`) → bump the
 *   release pin, which serves prod AND beta (beta runs prod's code by design;
 *   only its data channel differs)
 *
 * The pins are plain values files inside the worker's chart in k8s-config
 * (`<chartPath>/channels/{release,unstable}.yaml`), referenced per channel by
 * the ApplicationSets via helm valueFiles. Nothing references a mutable tag:
 * `:latest` is not pushed at all. */
export type WorkerCd = {
  /** Repo/binary name, e.g. "divvun-worker-grammar". Doubles as the cli
   * command prefix (`<name>-deploy`, `<name>-bump-manifest`), the ghcr image
   * name, and the Buildkite metadata key. */
  name: string
  /** Path within k8s-config to the worker's chart directory. */
  chartPath: string
}

export const DIVVUN_WORKER_GRAMMAR: WorkerCd = {
  name: "divvun-worker-grammar",
  chartPath: "charts/grammar-language",
}

export const DIVVUN_WORKER_SPELLER: WorkerCd = {
  name: "divvun-worker-speller",
  chartPath: "charts/speller-language",
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/

function image(cd: WorkerCd): string {
  return `ghcr.io/divvun/${cd.name}`
}

function releaseTag(): string | undefined {
  const tag = builder.env.tag
  return tag && RELEASE_TAG.test(tag) ? tag : undefined
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
  // A tag build that isn't a release tag has nothing to do.
  if (builder.env.tag && !releaseTag()) {
    return {
      steps: [
        {
          label: `Tag ${builder.env.tag} is not a release tag (vX.Y.Z); nothing to do`,
          command: "true",
          agents: { queue: "linux" },
        },
      ],
    }
  }

  // Release builds have env.tag set; main builds are filtered to main.
  const branches = releaseTag() ? undefined : "main"
  return {
    steps: [
      command({
        key: "build-push",
        label: "Build & Push",
        command: `divvun-actions run ${cd.name}-deploy`,
        agents: { queue: "linux" },
        branches,
      }),
      command({
        label: "Bump k8s chart",
        command: `divvun-actions run ${cd.name}-bump-manifest`,
        agents: { queue: "linux" },
        branches,
        depends_on: "build-push",
      }),
    ],
  }
}

export async function runWorkerCdDeploy(cd: WorkerCd) {
  const shaTag = `sha-${builder.env.commit}`
  const release = releaseTag()
  // Release builds also get the sha tag for traceability.
  const tags = release ? [release, shaTag] : [shaTag]

  await builder.exec("docker", [
    "build",
    ...tags.flatMap((t) => ["-t", `${image(cd)}:${t}`]),
    ".",
  ])

  await builder.group("Pushing image", async () => {
    await Promise.all(
      tags.map((t) => builder.exec("docker", ["push", `${image(cd)}:${t}`])),
    )
  })

  await builder.setMetadata(`${cd.name}-tag`, tags[0])
}

export async function runWorkerCdBumpManifest(cd: WorkerCd) {
  const tag = (await builder.metadata(`${cd.name}-tag`)).trim()
  if (tag.length === 0) {
    throw new Error(`Buildkite metadata ${cd.name}-tag was empty`)
  }

  const channel = releaseTag() ? "release" : "unstable"
  await bumpChartImageTag({
    imageName: image(cd),
    tag,
    valuesPath: `${cd.chartPath}/channels/${channel}.yaml`,
    imageKey: "workerImage",
    commitMessage: channel === "release"
      ? `Release ${cd.name} ${tag} (prod+beta)`
      : `Update ${cd.name} unstable image to ${tag}`,
  })
}
