import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { bumpArgoHelmImageTag } from "~/util/k8s-config.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineKeyboardViewer(): BuildkitePipeline {
  return {
    steps: [
      command({
        key: "lint",
        label: "Lint",
        command: "divvun-actions run keyboard-viewer-lint",
        agents: { queue: "linux" },
      }),
      command({
        key: "build-push",
        label: "Build & Push",
        command: "divvun-actions run keyboard-viewer-deploy",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "lint",
      }),
      command({
        label: "Bump k8s app manifest",
        command: "divvun-actions run keyboard-viewer-bump-manifest",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "build-push",
      }),
    ],
  }
}

export async function runKeyboardViewerLint() {
  await builder.exec("deno", ["fmt", "--check"])
  await builder.exec("deno", ["lint"])
  await builder.exec("deno", ["install"])
  await builder.exec("deno", ["check"])
}

export async function runKeyboardViewerDeploy() {
  const tag = `sha-${builder.env.commit}`

  await builder.exec("docker", [
    "build",
    "-t",
    "ghcr.io/divvun/keyboard-viewer:latest",
    "-t",
    `ghcr.io/divvun/keyboard-viewer:${tag}`,
    ".",
  ])

  await builder.group("Pushing image", async () => {
    await Promise.all([
      builder.exec("docker", ["push", "ghcr.io/divvun/keyboard-viewer:latest"]),
      builder.exec("docker", ["push", `ghcr.io/divvun/keyboard-viewer:${tag}`]),
    ])
  })

  await builder.setMetadata("keyboard-viewer-tag", tag)
}

export async function runKeyboardViewerBumpManifest() {
  const tag = (await builder.metadata("keyboard-viewer-tag")).trim()
  if (tag.length === 0) {
    throw new Error("Buildkite metadata keyboard-viewer-tag was empty")
  }

  await bumpArgoHelmImageTag({
    imageName: "ghcr.io/divvun/keyboard-viewer",
    tag,
    applicationPath: "apps/services/keyboard-viewer-app.yaml",
    commitMessage: `Update Keyboard Viewer image to ${tag}`,
  })
}
