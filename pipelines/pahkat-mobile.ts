// divvun/pahkat-next's mobile client, published from a tag
// mobile/v<version> at that version (dec:pahkat:mobile-packages): the
// xcframework as divvun.PahkatMobile to the Swift registry, and the Android
// library as no.divvun:pahkat-mobile to the Maven namespace divvun. The
// xcframework is built on macOS and published from Linux, where the pahkat
// CLI that CI fetches from the server runs.

import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import type { CommandStep } from "~/builder/pipeline.ts"
import { ExpectedError } from "~/util/error.ts"
import { publishRegistryPackage } from "~/util/pahkat.ts"
import { makeTempDir } from "~/util/temp.ts"

const NAMESPACE = "divvun"
const SWIFT_PACKAGE = "PahkatMobile"
const MAVEN_GROUP = "no.divvun"
const MAVEN_ARTIFACT = "pahkat-mobile"
const IOS_KEY = "pahkat-mobile-ios"

const swiftArchive = (version: string) =>
  `target/${SWIFT_PACKAGE}-${version}.zip`

export function mobileRelease(tag: string | undefined): string | null {
  return tag?.match(/^mobile\/v(\d.*)$/)?.[1] ?? null
}

/**
 * Refuse `version` unless, without its prerelease and build metadata, it
 * is the workspace's: a prerelease of the workspace's version, or that
 * version itself.
 */
export function checkMobileVersion(version: string, workspace: string) {
  const release = version.replace(/[-+].*$/, "")
  if (release !== workspace) {
    throw ExpectedError.create(
      `mobile/v${version} releases ${release}, but the workspace's version is ${workspace}`,
    )
  }
}

/** The tag and the version it releases, once the version is checked. */
async function mobileVersion(): Promise<{ tag: string; version: string }> {
  const tag = builder.env.tag
  const version = mobileRelease(tag)
  if (tag == null || version == null) {
    throw new Error(
      "Publishing the mobile client needs a tag mobile/v<version>",
    )
  }
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    workspace?: { package?: { version?: string } }
  }
  const workspace = cargo.workspace?.package?.version
  if (workspace == null) {
    throw new Error("Cargo.toml has no [workspace.package] version")
  }
  checkMobileVersion(version, workspace)
  return { tag, version }
}

/**
 * The steps that build and publish the mobile client, on a tag
 * mobile/v<version> only. `command` adds the divvun-actions plugin, as for
 * every step.
 */
export function pahkatMobileSteps(
  command: (step: CommandStep) => CommandStep,
): CommandStep[] {
  if (mobileRelease(builder.env.tag) == null) return []
  return [
    command({
      key: IOS_KEY,
      label: `Build ${SWIFT_PACKAGE} for iOS`,
      command: [
        "rustup target add aarch64-apple-ios aarch64-apple-ios-sim",
        "divvun-actions run pahkat-mobile-swift-archive",
      ],
      agents: { queue: "macos" },
    }),
    command({
      label: `Publish ${NAMESPACE}.${SWIFT_PACKAGE}`,
      command: "divvun-actions run pahkat-mobile-swift-publish",
      agents: { queue: "linux" },
      depends_on: IOS_KEY,
    }),
    command({
      label: `Publish ${MAVEN_GROUP}:${MAVEN_ARTIFACT}`,
      command: "divvun-actions run pahkat-mobile-maven-publish",
      agents: { queue: "linux" },
    }),
  ]
}

/**
 * Build the xcframework and archive it as the Swift registry takes it, for
 * the Linux step to publish.
 */
export async function runPahkatMobileSwiftArchive() {
  const { version } = await mobileVersion()
  await builder.exec(path.resolve("crates/mobile/build-ios.sh"))
  await builder.exec(path.resolve("crates/mobile/swift-archive.sh"), [version])
  await builder.uploadArtifacts(swiftArchive(version))
}

/** Publish the archive the macOS step made as divvun.PahkatMobile. */
export async function runPahkatMobileSwiftPublish() {
  const { tag, version } = await mobileVersion()
  using downloaded = await makeTempDir({ prefix: "pahkat-mobile-swift-" })
  await builder.downloadArtifacts(swiftArchive(version), downloaded.path)
  using release = await makeTempDir({ prefix: "pahkat-mobile-swift-" })
  const archive = path.basename(swiftArchive(version))
  await Deno.rename(
    path.join(downloaded.path, swiftArchive(version)),
    path.join(release.path, archive),
  )
  await publishRegistryPackage({
    module: "swift",
    namespace: NAMESPACE,
    dir: release.path,
    tag,
  })
}

/**
 * Build the Android library at the tag's version, lay it out with
 * publishToMavenLocal in a directory of its own, and publish it as
 * no.divvun:pahkat-mobile.
 */
export async function runPahkatMobileMavenPublish() {
  const { tag, version } = await mobileVersion()
  using repository = await makeTempDir({ prefix: "pahkat-mobile-maven-" })
  await builder.exec(path.resolve("crates/mobile/build-android.sh"), [
    `:${MAVEN_ARTIFACT}:publishToMavenLocal`,
    `-Pversion=${version}`,
    `-Dmaven.repo.local=${repository.path}`,
  ])
  await publishRegistryPackage({
    module: "maven",
    namespace: NAMESPACE,
    dir: path.join(
      repository.path,
      ...MAVEN_GROUP.split("."),
      MAVEN_ARTIFACT,
      version,
    ),
    tag,
  })
}
