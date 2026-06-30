import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { bumpArgoHelmImageTag } from "~/util/k8s-config.ts"

const IMAGE = "ghcr.io/divvun/drb-kicker"
const APPLICATION_PATH = "apps/services/drb-kicker-app.yaml"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineDrbKicker(): BuildkitePipeline {
  return {
    steps: [
      command({
        key: "lint",
        label: "Lint",
        command: "divvun-actions run drb-kicker-lint",
        agents: { queue: "linux" },
      }),
      command({
        key: "build-push",
        label: "Build & Push",
        command: "divvun-actions run drb-kicker-deploy",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "lint",
      }),
      command({
        label: "Bump k8s app manifest",
        command: "divvun-actions run drb-kicker-bump-manifest",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "build-push",
      }),
    ],
  }
}

export async function runDrbKickerLint() {
  await builder.exec("cargo", ["fmt", "--check"])
  await builder.exec("cargo", [
    "clippy",
    "--all-targets",
    "--",
    "-D",
    "warnings",
  ])
}

export async function runDrbKickerDeploy() {
  const tag = `sha-${builder.env.commit}`

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

  await builder.setMetadata("drb-kicker-tag", tag)
}

export async function runDrbKickerBumpManifest() {
  const tag = (await builder.metadata("drb-kicker-tag")).trim()
  if (tag.length === 0) {
    throw new Error("Buildkite metadata drb-kicker-tag was empty")
  }

  await bumpArgoHelmImageTag({
    imageName: IMAGE,
    tag,
    applicationPath: APPLICATION_PATH,
    commitMessage: `Update drb-kicker image to ${tag}`,
  })
}
