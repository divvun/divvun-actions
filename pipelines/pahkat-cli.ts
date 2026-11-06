// divvun/pahkat-next's main builds publish the pahkat CLI as dev releases of
// main/pahkat: a .pkt.box holding bin/pahkat, a static musl build, which
// CI's Pahkat steps fetch from the server and check (util/pahkat.ts).

import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { CommandStep } from "~/builder/pipeline.ts"
import {
  type Arch,
  type Artifact,
  PAHKAT_CLI_PACKAGE,
  publishRelease,
} from "~/util/pahkat.ts"
import { createPktBox } from "~/util/pkt_box.ts"
import { versionAsNightly } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

/**
 * The targets the CLI is published for. CI's Linux agents are x86_64;
 * aarch64 needs the cross sysroot gut and cg3-rs build with.
 */
const TARGETS = ["x86_64-unknown-linux-musl"] as const

/** The GitHub release the attestation names, which pahkat-next has none of. */
const DEV_TAG = "dev-latest"

const buildKey = (target: string) => `pahkat-cli-${target}`
const binary = (target: string) => `target/${target}/release/pahkat`

/**
 * Build the CLI for each target, and on main publish them as one release.
 * `command` adds the divvun-actions plugin, as for every step.
 */
export function pahkatCliSteps(
  command: (step: CommandStep) => CommandStep,
): CommandStep[] {
  const steps = TARGETS.map((target) =>
    command({
      key: buildKey(target),
      label: `Build CLI (${target})`,
      command: [
        `rustup target add ${target}`,
        `cargo build --release --locked -p pahkat-cli --bin pahkat --target ${target}`,
        `buildkite-agent artifact upload ${binary(target)}`,
      ],
      agents: { queue: "alpine" },
    })
  )
  if (builder.env.branch === "main") {
    steps.push(command({
      label: "Publish CLI to Pahkat",
      command: "divvun-actions run pahkat-cli-publish",
      depends_on: TARGETS.map(buildKey),
      soft_fail: true,
      agents: { queue: "linux" },
    }))
  }
  return steps
}

/**
 * Publish this build's CLI for every target as a dev release of
 * main/pahkat, uploaded with the CLI for this agent's architecture.
 */
export async function runPahkatCliPublish() {
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    workspace: { package: { version: string; license: string } }
  }
  const { version: base, license } = cargo.workspace.package
  const version = await versionAsNightly(base, builder.env.buildNumber)

  using dir = await makeTempDir({ prefix: "pahkat-cli-" })
  const artifacts: Artifact[] = []
  let cli: string | undefined
  for (const target of TARGETS) {
    await builder.downloadArtifacts(binary(target), dir.path)
    const built = path.join(dir.path, binary(target))
    await Deno.chmod(built, 0o755)
    const arch = target.split("-", 1)[0] as Arch
    if (arch === Deno.build.arch) cli = built

    const box = path.join(
      dir.path,
      `${PAHKAT_CLI_PACKAGE}_${version}_linux_${arch}.pkt.box`,
    )
    await createPktBox(box, {
      pkg: PAHKAT_CLI_PACKAGE,
      version,
      files: [{ path: built, at: "bin/pahkat" }],
    })
    artifacts.push({ path: box, kind: "box", os: ["linux"], arch: [arch] })
  }
  if (cli == null) {
    throw new Error(
      `This build makes no pahkat CLI for ${Deno.build.arch} to publish with`,
    )
  }

  await publishRelease({
    package: PAHKAT_CLI_PACKAGE,
    version,
    tag: DEV_TAG,
    metadata: {
      names: { en: "Pahkat" },
      descriptions: {
        en: "pahkat, the command line client of the Pahkat package manager",
      },
      authors: ["Divvun"],
      license,
      tags: ["cat:ci"],
    },
    artifacts,
    cli,
  })
}
