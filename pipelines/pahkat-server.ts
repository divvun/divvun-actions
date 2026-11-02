import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { bumpArgoKustomizeImageTag } from "~/util/k8s-config.ts"

const IMAGE = "ghcr.io/divvun/pahkat-server"
const APPLICATION_PATH = "apps/services/pahkat-server-app.yaml"
const TAG_METADATA = "pahkat-server-tag"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

/**
 * CD for the Pahkat server, from divvun/pahkat-next. On push to main: build
 * the repo's Containerfile, push `ghcr.io/divvun/pahkat-server:sha-<commit>`,
 * and pin that tag in the server's Argo CD Application in k8s-config. The
 * Kustomize manifests live in pahkat-next itself, so the pin is the
 * Application's `spec.source.kustomize.images` rather than a
 * kustomization.yaml in k8s-config. No mutable `:latest`.
 */
export function pipelinePahkatServer(): BuildkitePipeline {
  return {
    steps: [
      command({
        key: "build-push",
        label: "Build & Push",
        command: "divvun-actions run pahkat-server-deploy",
        agents: { queue: "linux" },
        branches: "main",
      }),
      command({
        // EXPECTED TO SOFT-FAIL until the server's Argo CD Application exists
        // in k8s-config (Pahkat's server.deploy work adds it). Drop the
        // soft_fail once this step has been seen green.
        label: "Bump k8s app manifest (soft-fail until the app exists)",
        command: "divvun-actions run pahkat-server-bump-manifest",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "build-push",
        soft_fail: true,
      }),
    ],
  }
}

export async function runPahkatServerDeploy() {
  const commit = builder.env.commit
  if (!commit) {
    throw new Error("BUILDKITE_COMMIT is not set")
  }
  const tag = `sha-${commit}`

  // The file is a Containerfile, which docker does not look for by itself.
  // It needs BuildKit for its cache mounts and TARGETARCH.
  await builder.exec("docker", [
    "build",
    "-f",
    "Containerfile",
    "-t",
    `${IMAGE}:${tag}`,
    ".",
  ], { env: { DOCKER_BUILDKIT: "1" } })

  await builder.group("Pushing image", async () => {
    await builder.exec("docker", ["push", `${IMAGE}:${tag}`])
  })

  await builder.setMetadata(TAG_METADATA, tag)
}

export async function runPahkatServerBumpManifest() {
  const tag = (await builder.metadata(TAG_METADATA)).trim()
  if (tag.length === 0) {
    throw new Error(`Buildkite metadata ${TAG_METADATA} was empty`)
  }

  await bumpArgoKustomizeImageTag({
    imageName: IMAGE,
    tag,
    applicationPath: APPLICATION_PATH,
    commitMessage: `Update pahkat-server image to ${tag}`,
  })
}
