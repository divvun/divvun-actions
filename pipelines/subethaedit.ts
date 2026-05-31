import * as path from "@std/path"
import { signSubethaedit } from "~/actions/subethaedit/sign.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import { notarizeAndStaple } from "~/services/macos-codesign.ts"
import * as target from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { logXcodeVersion } from "~/util/xcode.ts"

const WORKSPACE = "SubEthaEdit.xcworkspace"
const SCHEME = "SubEthaEdit"
/** Directory in the checkout holding the per-target entitlement plists. */
const ENTITLEMENTS_DIR = "SubEthaEdit-Mac"
/** Built product path under the xcodebuild derived data dir. */
const APP_PATH = "build/Build/Products/Release/SubEthaEdit.app"
/** Buildkite metadata key carrying the artifact name across to publish. */
const ARTIFACT_META_KEY = "subethaedit-artifact"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export function pipelineSubethaedit(): BuildkitePipeline {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  const steps: BuildkitePipeline["steps"] = [
    command({
      label: "Build & Sign",
      key: "build-macos",
      command: "divvun-actions run subethaedit-build-macos",
      agents: { queue: "macos" },
    }),
  ]

  if (isRelease || isMainBranch) {
    steps.push(command({
      label: `Publish (${isRelease ? "Release" : "Dev"})`,
      command: "divvun-actions run subethaedit-publish",
      agents: { queue: "linux" },
      depends_on: "build-macos",
    }))
  }

  return { steps }
}

/** Read CFBundleShortVersionString from the built app, falling back to the tag. */
async function readAppVersion(appPath: string): Promise<string> {
  const result = await builder.output("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    path.join(appPath, "Contents/Info.plist"),
  ])
  const version = result.stdout.trim()
  if (result.status.code === 0 && version.length > 0) {
    return version
  }
  return builder.env.tag ?? "dev"
}

export async function runSubethaeditBuildMacOS() {
  await logXcodeVersion()

  await builder.group("Initializing submodules", async () => {
    await builder.exec("git", ["submodule", "update", "--init", "--recursive"])
  })

  await builder.group("Building SubEthaEdit (Release, unsigned)", async () => {
    // Build unsigned: the agents have no Developer ID identity in the keychain,
    // and signing happens afterwards via rcodesign + the vault cert.
    await builder.exec("xcodebuild", [
      "-workspace",
      WORKSPACE,
      "-scheme",
      SCHEME,
      "-configuration",
      "Release",
      "-derivedDataPath",
      "build",
      "CODE_SIGNING_ALLOWED=NO",
      "CODE_SIGNING_REQUIRED=NO",
      "build",
    ])
  })

  await builder.group("Signing", async () => {
    await signSubethaedit(APP_PATH, ENTITLEMENTS_DIR)
  })

  await builder.group("Notarizing & stapling", async () => {
    await notarizeAndStaple(APP_PATH)
  })

  await builder.group("Packaging & uploading", async () => {
    const version = await readAppVersion(APP_PATH)
    const zipName = `SubEthaEdit-${version}.zip`

    // ditto preserves the signature metadata that a plain zip would strip.
    await builder.exec("ditto", ["-c", "-k", "--keepParent", APP_PATH, zipName])

    await builder.setMetadata(ARTIFACT_META_KEY, zipName)
    await builder.uploadArtifacts(zipName)
  })
}

export async function runSubethaeditPublish() {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  if (!isRelease && !isMainBranch) {
    throw new Error("subethaedit-publish requires a version tag or main branch")
  }
  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  const zipName = (await builder.metadata(ARTIFACT_META_KEY)).trim()
  if (zipName.length === 0) {
    throw new Error(`No ${ARTIFACT_META_KEY} metadata found`)
  }

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(zipName, tempDir.path)
  const zipPath = path.join(tempDir.path, zipName)

  const gh = new GitHub(builder.env.repo)

  if (isRelease) {
    logger.info(`Creating release ${builder.env.tag}`)
    await gh.createRelease(builder.env.tag!, [zipPath], { latest: true })
  } else {
    logger.info("Publishing to dev-latest")
    await gh.updateRelease("dev-latest", [zipPath], {
      draft: false,
      prerelease: true,
      name: zipName.replace(/\.zip$/, ""),
    })
  }
}
