// necessary-nu/frakt: its tests on Linux, macOS and Windows, each on the
// backend native to the system, and on a tag v<version> its Android worker
// published as nu.necessary:frakt-background to the Pahkat server's Maven
// repository divvun (dec:pahkat:mobile-packages).

import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { ExpectedError } from "~/util/error.ts"
import { publishRegistryPackage } from "~/util/pahkat.ts"
import { makeTempDir } from "~/util/temp.ts"

const GROUP = "nu.necessary"
const ARTIFACT = "frakt-background"
const MAVEN_NAMESPACE = "divvun"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

/** The version a tag `v<version>` releases, or null for any other build. */
export function fraktRelease(tag: string | undefined): string | null {
  return tag?.match(/^v(\d.*)$/)?.[1] ?? null
}

/**
 * The integration tests call httpbin.org, which answers 429 to more than
 * two requests a second to its echo endpoints, so the tests run one at a
 * time.
 */
const ONE_AT_A_TIME = "--test-threads=1"

export function pipelineFrakt(): BuildkitePipeline {
  const steps: CommandStep[] = [
    command({
      key: "test-linux",
      label: "Test on Linux (reqwest)",
      command: `cargo test --locked -- ${ONE_AT_A_TIME}`,
      env: { BACKEND: "reqwest" },
      agents: { queue: "linux" },
    }),
    command({
      key: "test-macos",
      label: "Test on macOS (Foundation)",
      command:
        `cargo test --locked --features backend-foundation -- ${ONE_AT_A_TIME}`,
      env: { BACKEND: "foundation" },
      agents: { queue: "macos" },
    }),
    command({
      key: "test-windows",
      label: "Test on Windows (WinHTTP)",
      command:
        `cargo test --locked --features backend-winhttp -- ${ONE_AT_A_TIME}`,
      env: { BACKEND: "windows" },
      agents: { queue: "windows" },
    }),
    command({
      key: "android-worker",
      label: "Build frakt-background",
      command:
        "cd android && ./gradlew --no-daemon :frakt-background:assembleRelease",
      agents: { queue: "linux" },
    }),
  ]

  if (fraktRelease(builder.env.tag) != null) {
    steps.push(command({
      label: `Publish ${GROUP}:${ARTIFACT}`,
      command: "divvun-actions run frakt-publish",
      agents: { queue: "linux" },
      depends_on: steps.map((step) => step.key!),
    }))
  }

  return { steps }
}

/**
 * Publish frakt-background at the version the tag names, which must be
 * frakt's own, so the worker and the crate whose Rust half calls it carry
 * one version.
 */
export async function runFraktPublish() {
  const tag = builder.env.tag
  const version = fraktRelease(tag)
  if (tag == null || version == null) {
    throw new Error("frakt-publish requires a tag v<version>")
  }
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    package?: { version?: string }
  }
  if (cargo.package?.version !== version) {
    throw ExpectedError.create(
      `The tag ${tag} names ${version}, but frakt's Cargo.toml is at ${cargo.package?.version}`,
    )
  }

  using repository = await makeTempDir({ prefix: "frakt-maven-" })
  const android = path.resolve("android")
  await builder.exec(path.join(android, "gradlew"), [
    "--no-daemon",
    ":frakt-background:publishToMavenLocal",
    `-Pversion=${version}`,
    `-Dmaven.repo.local=${repository.path}`,
  ], { cwd: android })

  await publishRegistryPackage({
    module: "maven",
    namespace: MAVEN_NAMESPACE,
    dir: path.join(repository.path, ...GROUP.split("."), ARTIFACT, version),
    tag,
  })
}
