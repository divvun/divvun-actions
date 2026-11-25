import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { pinArgoKustomizeImageDigest } from "~/util/k8s-config.ts"
import logger from "~/util/log.ts"
import { pahkatCliSteps } from "./pahkat-cli.ts"
import { pahkatMobileSteps } from "./pahkat-mobile.ts"

const IMAGE = "ghcr.io/divvun/pahkat-server"
const APPLICATION_PATH = "apps/services/pahkat-server-app.yaml"
const TAG_METADATA = "pahkat-server-tag"
/** The step that pins the new image, which deploys it. */
const BUMP_KEY = "bump-manifest"
const DIGEST_METADATA = "pahkat-server-digest"

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
 * and pin the digest that push reports in the server's Argo CD Application in
 * k8s-config. The Kustomize manifests live in pahkat-next itself, so the pin
 * is the Application's `spec.source.kustomize.images` rather than a
 * kustomization.yaml in k8s-config. The cluster never deploys by tag, which
 * anyone who can push to the package could point elsewhere.
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
        key: BUMP_KEY,
        label: "Bump k8s app manifest",
        command: "divvun-actions run pahkat-server-bump-manifest",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: "build-push",
      }),
      ...pahkatCliSteps(command, BUMP_KEY),
      ...pahkatMobileSteps(command),
    ],
  }
}

/**
 * The digest `docker push` reports for `tag` on its line
 * `<tag>: digest: sha256:<hex> size: <bytes>`: that of the manifest, or
 * manifest list, the push stored under the tag.
 */
export function pushedDigest(pushOutput: string, tag: string): string {
  const digests = new Set(
    pushOutput.split("\n").flatMap((line) => {
      const match = line.trim().match(
        /^(\S+): digest: (sha256:[0-9a-f]{64}) size: \d+$/,
      )
      return match && match[1] === tag ? [match[2]] : []
    }),
  )
  if (digests.size !== 1) {
    throw new Error(
      `docker push reported ${digests.size} digests for ${tag}, not one`,
    )
  }
  return [...digests][0]
}

export async function runPahkatServerDeploy() {
  const commit = builder.env.commit
  if (!commit) {
    throw new Error("BUILDKITE_COMMIT is not set")
  }
  const tag = `sha-${commit}`

  // The file is a Containerfile, which docker does not look for by itself.
  // It needs BuildKit for its cache mounts and TARGETARCH. The server
  // answers its commit at /version, which the CLI's publish waits for.
  await builder.exec("docker", [
    "build",
    "-f",
    "Containerfile",
    "--build-arg",
    `PAHKAT_COMMIT=${commit}`,
    "-t",
    `${IMAGE}:${tag}`,
    ".",
  ], { env: { DOCKER_BUILDKIT: "1" } })

  let digest = ""
  await builder.group("Pushing image", async () => {
    const push = await builder.output("docker", ["push", `${IMAGE}:${tag}`])
    logger.info(push.stdout)
    if (!push.status.success) {
      throw new Error(
        `docker push exited with code ${push.status.code}: ${push.stderr}`,
      )
    }
    digest = pushedDigest(`${push.stdout}\n${push.stderr}`, tag)
  })

  await builder.setMetadata(TAG_METADATA, tag)
  await builder.setMetadata(DIGEST_METADATA, digest)
}

export async function runPahkatServerBumpManifest() {
  const tag = (await builder.metadata(TAG_METADATA)).trim()
  if (tag.length === 0) {
    throw new Error(`Buildkite metadata ${TAG_METADATA} was empty`)
  }
  const digest = (await builder.metadata(DIGEST_METADATA)).trim()

  await pinArgoKustomizeImageDigest({
    imageName: IMAGE,
    digest,
    applicationPath: APPLICATION_PATH,
    commitMessage: `Update pahkat-server image to ${tag}, digest ${digest}`,
  })
}
