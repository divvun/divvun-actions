import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import { fcVersions, KERNEL_IMAGE_REF } from "~/firecracker/versions.ts"
import * as targetModule from "~/target.ts"

type TargetSpec = {
  target: string
  /** Buildkite agent queue to schedule the build on. */
  queue: "linux" | "windows"
  /**
   * If set, this target's `docker build` won't start until the named target's
   * build+push completes (used for `windows` depending on `windows-vsbase`).
   */
  dependsOn?: string
  /**
   * Pass `--platform <plat>` to docker build. Omit on windows since the
   * Windows daemon only knows windows containers.
   */
  platform?: string
  /**
   * A hand-written Dockerfile, for images outside docker/images/*.ts. Omit
   * to build what docker/generate.ts makes for `target`.
   */
  dockerfile?: {
    ref: string
    path: string
    context: string
    buildArgs: Record<string, string>
  }
}

const TARGET_SPECS: TargetSpec[] = [
  { target: "alpine", queue: "linux", platform: "linux/amd64" },
  { target: "linux", queue: "linux", platform: "linux/amd64" },
  { target: "windows-vsbase", queue: "windows" },
  { target: "windows", queue: "windows", dependsOn: "build-windows-vsbase" },
  {
    target: "fc-kernel",
    queue: "linux",
    platform: "linux/amd64",
    dockerfile: {
      ref: KERNEL_IMAGE_REF,
      path: "firecracker/kernel/Dockerfile",
      context: "firecracker/kernel",
      buildArgs: {
        KERNEL_TAG: fcVersions.kernel.tag,
        FIRECRACKER_VERSION: fcVersions.firecracker.version,
        KERNEL_CONFIG: fcVersions.kernel.config,
      },
    },
  },
]
const VALID_TARGETS = TARGET_SPECS.map((s) => s.target)

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineDivvunActions(): BuildkitePipeline {
  // Images are built only for tagged releases. They take a long time, the
  // agents pull `:latest` on their own schedule, and rebuilding on every commit
  // to main means the layer cache is the only thing standing between a routine
  // change and a rebuild of every image.
  //
  // DOCKER_BUILD_IMAGES=true forces a build without tagging, set as a Buildkite
  // "New Build" environment variable override — same escape hatch as
  // DOCKER_NO_CACHE below, and the way to roll out an image fix between
  // releases.
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isForced = Deno.env.get("DOCKER_BUILD_IMAGES") === "true"

  // The drift check is cheap and catches generated Dockerfiles falling out of
  // step with docker/images/*.ts, so it runs on every build regardless.
  const steps: BuildkitePipeline["steps"] = [
    command({
      key: "drift-check",
      label: ":mag: Dockerfile drift check",
      command: ["deno task docker:check"],
      agents: { queue: "linux" },
    }),
  ]

  if (!isRelease && !isForced) {
    return { steps }
  }

  steps.push({ wait: null })

  for (const spec of TARGET_SPECS) {
    const dependsOn = spec.dependsOn ? [spec.dependsOn] : ["drift-check"]
    steps.push(
      command({
        key: `build-${spec.target}`,
        label: `:whale: Build ${spec.target}`,
        command: [
          `divvun-actions run divvun-actions-build-image ${spec.target} push`,
        ],
        agents: { queue: spec.queue },
        depends_on: dependsOn,
      }),
    )
  }

  return { steps }
}

export async function runDivvunActionsBuildImage(
  target: string,
  pushArg: string,
) {
  const spec = TARGET_SPECS.find((s) => s.target === target)
  if (!spec) {
    throw new Error(
      `Unknown target: ${target}. Expected one of: ${VALID_TARGETS.join(", ")}`,
    )
  }
  const shouldPush = pushArg === "push"

  const image = spec.dockerfile ?? (await generatedImage(target))

  const buildArgs = ["build"]
  if (spec.platform) buildArgs.push("--platform", spec.platform)
  // Escape hatch for when an upstream dependency (e.g. a tool fetched via
  // `curl` mid-Dockerfile) has moved but the layer instruction text hasn't,
  // so Docker's cache would otherwise keep serving the stale layer. Set via
  // a Buildkite "New Build" environment variable override.
  if (Deno.env.get("DOCKER_NO_CACHE") === "true") buildArgs.push("--no-cache")
  for (const [name, value] of Object.entries(image.buildArgs)) {
    buildArgs.push("--build-arg", `${name}=${value}`)
  }
  buildArgs.push("-t", image.ref, "-f", image.path, image.context)

  await builder.exec("docker", buildArgs)

  if (shouldPush) {
    await builder.exec("docker", ["push", image.ref])
  }
}

async function generatedImage(
  target: string,
): Promise<NonNullable<TargetSpec["dockerfile"]>> {
  // Regenerate first; the upstream drift check guarantees no real changes,
  // but doing this here keeps the build hermetic if anyone runs the action
  // directly off the CI path.
  await builder.exec("deno", [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-env",
    "docker/generate.ts",
    `--only=${target}`,
  ])

  const refOutput = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      "docker/generate.ts",
      `--print-ref=${target}`,
    ],
    stdout: "piped",
  }).output()
  if (!refOutput.success) {
    throw new Error(`failed to resolve image ref for ${target}`)
  }
  return {
    ref: new TextDecoder().decode(refOutput.stdout).trim(),
    path: `docker/Dockerfile.${target}`,
    context: "docker",
    buildArgs: {},
  }
}
