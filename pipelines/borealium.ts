import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { bumpKustomizeImageTag } from "~/util/k8s-config.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineBorealium(): BuildkitePipeline {
  return {
    steps: [
      command({
        label: "Build & Push",
        key: "borealium-deploy",
        command: "divvun-actions run borealium-deploy",
        agents: { queue: "linux" },
      }),
      command({
        label: "Bump k8s app manifest",
        command: "divvun-actions run borealium-bump-manifest",
        agents: { queue: "linux" },
        depends_on: "borealium-deploy",
      }),
    ],
  }
}

export async function runBorealiumDeploy() {
  const tag = `sha-${builder.env.commit}`

  await builder.exec("docker", [
    "build",
    "-t",
    "ghcr.io/divvun/borealium:latest",
    "-t",
    `ghcr.io/divvun/borealium:${tag}`,
    ".",
  ])

  await builder.group("Pushing image", async () => {
    await Promise.all([
      builder.exec("docker", ["push", "ghcr.io/divvun/borealium:latest"]),
      builder.exec("docker", ["push", `ghcr.io/divvun/borealium:${tag}`]),
    ])
  })

  await builder.setMetadata("borealium-tag", tag)
}

export async function runBorealiumBumpManifest() {
  const tag = (await builder.metadata("borealium-tag")).trim()
  if (tag.length === 0) {
    throw new Error("Buildkite metadata borealium-tag was empty")
  }

  await bumpKustomizeImageTag({
    imageName: "ghcr.io/divvun/borealium",
    tag,
    kustomizationPath: "kustomize/borealium/kustomization.yaml",
    commitMessage: `Update Borealium image to ${tag}`,
  })
}
