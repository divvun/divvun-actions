import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import keyboardBuildMeta from "~/actions/keyboard/build-meta.ts"
import keyboardBuild, {
  type InstallerKind,
} from "~/actions/keyboard/build/mod.ts"
import type { KeyboardToolchainKind } from "~/actions/keyboard/build/toolchain.ts"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import { NIGHTLY_CHANNEL } from "~/actions/version.ts"
import * as builder from "~/builder.ts"
import {
  BuildkitePipeline,
  CommandStep,
  GroupStep,
} from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { globFiles, globOneFile } from "~/util/glob.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import { logXcodeVersion } from "~/util/xcode.ts"
import keyboardDeploy from "../../actions/keyboard/deploy.ts"
import { sentryUploadIOSDebugFiles } from "../../actions/sentry/upload-debug-files.ts"
import { Ditto, Kbdgen, versionAsNightly } from "../../util/shared.ts"

export async function runDivvunKeyboardIOS(kbdgenBundlePath: string) {
  const secrets = await builder.secrets()
  // await builder.group("Initializing Pahkat", async () => {
  //   await pahkatInit({
  //     repoUrl: "https://pahkat.uit.no/devtools/",
  //     channel: "nightly",
  //     packages: ["kbdgen"],
  //   })
  // })

  await logXcodeVersion()

  await builder.group("Building Divvun Keyboard for iOS", async () => {
    await keyboardBuildMeta({
      keyboardType: KeyboardType.iOS,
      bundlePath: kbdgenBundlePath,
    })
  })

  if (builder.env.branch === "main") {
    await builder.group("Uploading to App Store", async () => {
      const apiKey = JSON.parse(secrets.get("macos/appStoreKeyJson"))
      await fastlanePilotUpload({
        apiKey,
        ipaPath: "output/ipa/HostingApp.ipa",
      })
    })
  } else {
    logger.info("Not main branch; skipping upload")
  }

  await builder.group("Uploading debug files to Sentry", async () => {
    const projectId = builder.env.repoName === "divvun-dev-keyboard"
      ? "divvun-dev-keyboard-ios"
      : "sami-keyboards-ios"
    await sentryUploadIOSDebugFiles({
      authToken: secrets.get("sentry/token"),
      projectId: projectId,
      dsymSearchPath: "output",
    })
  })
}

export async function runDivvunKeyboardAndroid(kbdgenBundlePath: string) {
  await builder.group("Building Divvun Keyboard for Android", async () => {
    await keyboardBuildMeta({
      keyboardType: KeyboardType.Android,
      bundlePath: kbdgenBundlePath,
    })
  })

  if (builder.env.branch === "main") {
    await builder.group("Publishing APK to Google Play Console", async () => {
      const secrets = await builder.secrets()
      await builder.exec("./gradlew", ["publishApk"], {
        cwd: "output/repo",
        env: {
          "ANDROID_PUBLISHER_CREDENTIALS": secrets.get(
            "android/divvun/googleServiceAccountJson",
          ),
        },
      })
    })
  } else {
    logger.info("Not main branch; skipping upload")
  }
}

async function createWindowsPackage(
  payloadPath: string,
  packageId: string,
  version: string,
  unsigned: boolean,
): Promise<string> {
  using tempDir = await makeTempDir()

  const pathItems = [packageId, version, "windows"]
  const unsignedSuffix = unsigned ? ".UNSIGNED" : ""
  const packageFileName = `${pathItems.join("_")}${unsignedSuffix}.exe`
  const packagePath = path.join(tempDir.path, packageFileName)

  await Deno.copyFile(payloadPath, packagePath)
  return packagePath
}

export async function runDesktopKeyboardWindows(
  kbdgenBundlePath: string,
  installer?: InstallerKind,
  toolchain: KeyboardToolchainKind = "production",
) {
  logger.info(
    `Building Divvun Keyboard for Windows (installer: ${
      installer ?? "default"
    }, toolchain: ${toolchain})`,
  )

  const { payloadPath, channel, unsigned } = await keyboardBuild({
    keyboardType: KeyboardType.Windows,
    bundlePath: kbdgenBundlePath,
    installer,
    toolchain,
  })

  // keyboardBuild stamped the bundle's windows target with the installer's
  // version, nightly unless a release tag is built. A v4 build is named and
  // deployed with exactly that: pahkat compares the release version with the
  // DisplayVersion outto registers, which is that version. Production builds
  // stamp the nightly version again, with the build number.
  const target = await Kbdgen.loadTarget(kbdgenBundlePath, "windows")
  const builtVersion = target.version as string
  const fullVersion = channel && toolchain !== "v4"
    ? await versionAsNightly(builtVersion, builder.env.buildNumber)
    : builtVersion

  // kbdgen v4 test builds are named apart from production ones.
  const packageId = toolchain === "v4"
    ? `${builder.env.repoName}${KBDGEN_V4_PACKAGE_SUFFIX}`
    : builder.env.repoName
  const artifactPath = await createWindowsPackage(
    payloadPath,
    packageId,
    fullVersion,
    unsigned,
  )

  // Upload artifact for later deployment
  await builder.uploadArtifacts(artifactPath)

  // Store metadata for deployment
  await builder.setMetadata("windows-channel", channel || "")
  await builder.setMetadata("windows-version", fullVersion)
  await builder.setMetadata("bundle-path", kbdgenBundlePath)

  logger.info("Windows keyboard built and artifact uploaded")
}

async function createMacosPackage(
  payloadPath: string,
  packageId: string,
  bundlePath: string,
  channel: string | null,
): Promise<string> {
  using tempDir = await makeTempDir()

  // Get version from kbdgen bundle
  const target = await Kbdgen.loadTarget(bundlePath, "macos")
  const baseVersion = target.version as string

  // Apply channel and timestamp if this is a dev build
  const version = channel
    ? await versionAsNightly(baseVersion, builder.env.buildNumber)
    : baseVersion

  const pathItems = [packageId, version, "macos"]
  const packageFileName = `${pathItems.join("_")}.pkg`
  const packagePath = path.join(tempDir.path, packageFileName)

  await Deno.copyFile(payloadPath, packagePath)
  return packagePath
}

/**
 * Wrap an outto-produced .app bundle into a ditto zip so Buildkite can
 * upload it as a single artifact. ditto preserves resource forks, xattrs,
 * and codesign signatures (plain `zip` doesn't).
 */
async function createMacosOuttoArtifact(
  appPath: string,
  packageId: string,
  bundlePath: string,
  channel: string | null,
): Promise<string> {
  using tempDir = await makeTempDir()

  const target = await Kbdgen.loadTarget(bundlePath, "macos")
  const baseVersion = target.version as string
  const version = channel
    ? await versionAsNightly(baseVersion, builder.env.buildNumber)
    : baseVersion

  const archiveName = `${packageId}_${version}_macos.app.zip`
  const archivePath = path.join(tempDir.path, archiveName)
  await Ditto.zipApp(appPath, archivePath)
  return archivePath
}

export async function runDesktopKeyboardMacOS(
  kbdgenBundlePath: string,
  installer?: InstallerKind,
) {
  logger.info(
    `Building Divvun Keyboard for macOS (installer: ${installer ?? "default"})`,
  )

  await logXcodeVersion()

  const { payloadPath, channel } = await keyboardBuild({
    keyboardType: KeyboardType.MacOS,
    bundlePath: kbdgenBundlePath,
    installer,
  })
  // Note: unsigned is always false for macOS builds

  // outto on macOS emits a .app *directory*. Ditto-zip it to preserve
  // codesign + xattrs and produce a single uploadable artifact. Legacy
  // path produces a single .pkg file and uses createMacosPackage().
  let artifactPath: string
  if (installer === "outto") {
    artifactPath = await createMacosOuttoArtifact(
      payloadPath,
      builder.env.repoName,
      kbdgenBundlePath,
      channel,
    )
  } else {
    artifactPath = await createMacosPackage(
      payloadPath,
      builder.env.repoName,
      kbdgenBundlePath,
      channel,
    )
  }

  await builder.uploadArtifacts(artifactPath)

  // Get the full version (including dev timestamp) from the artifact
  const target = await Kbdgen.loadTarget(kbdgenBundlePath, "macos")
  const baseVersion = target.version as string
  const fullVersion = channel
    ? await versionAsNightly(baseVersion, builder.env.buildNumber)
    : baseVersion

  // Store metadata for deployment
  await builder.setMetadata("macos-channel", channel || "")
  await builder.setMetadata("macos-version", fullVersion)
  await builder.setMetadata("bundle-path", kbdgenBundlePath)

  logger.info("macOS keyboard built and artifact uploaded")
}

/**
 * Rolling pre-release the outto keyboard installers are published to.
 *
 * The legacy chain deploys to Pahkat, which outto cannot use yet: there is no
 * Pahkat payload type describing an outto `.exe` or an `.app` bundle installer
 * (see the note at the top of actions/keyboard/build/outto.ts, and the
 * hardcoded WindowsExecutableKind.Inno in actions/keyboard/deploy.ts). Until
 * that lands, publish to GitHub the way outto, divvun-wind and divvun-runtime
 * already do.
 */
const OUTTO_DEV_TAG = "dev-latest"

/** Download one artifact glob, tolerating the producing step having soft-failed. */
async function downloadOuttoArtifacts(pattern: string, outputDir: string) {
  try {
    await builder.downloadArtifacts(pattern, outputDir)
  } catch {
    // `buildkite-agent artifact download` exits non-zero when nothing matches.
    // Both outto builds are soft_fail, so one platform missing is expected
    // rather than fatal — publishing the one that did build is still useful.
    logger.warning(`No artifacts matched ${pattern}; skipping`)
  }
}

export async function runDesktopKeyboardDeployOutto() {
  using tempDir = await makeTempDir()

  // Artifact names come from createWindowsPackage/createMacosOuttoArtifact:
  //   <repoName>_<version>_windows.exe
  //   <repoName>_<version>_macos.app.zip
  // The legacy macOS build uploads a .pkg into this same build, so these
  // patterns must stay narrow enough to exclude it.
  await downloadOuttoArtifacts("*_windows.exe", tempDir.path)
  await downloadOuttoArtifacts("*_macos.app.zip", tempDir.path)

  const files: string[] = []
  for await (const entry of Deno.readDir(tempDir.path)) {
    if (!entry.isFile) continue
    // An unsigned installer on a public release is worse than no installer,
    // so drop any that reach here and say so loudly.
    if (entry.name.includes(".UNSIGNED.")) {
      logger.warning(`Refusing to publish unsigned installer: ${entry.name}`)
      continue
    }
    files.push(path.join(tempDir.path, entry.name))
  }

  if (files.length === 0) {
    throw new Error(
      "No signed outto keyboard installers to publish. Both outto build steps " +
        "are soft_fail, so check whether they actually produced an artifact.",
    )
  }

  // Both the legacy and outto macOS builds write this, and agree on the value.
  // Only used to name the release, so a miss is not worth failing the deploy.
  let version: string | undefined
  try {
    version = await builder.metadata("macos-version")
  } catch {
    logger.warning("No macos-version metadata; leaving the release name as is")
  }

  logger.info(
    `Publishing to ${OUTTO_DEV_TAG}: ${
      files.map((f) => path.basename(f)).join(", ")
    }`,
  )
  const gh = new GitHub(builder.env.repo)
  await gh.updateRelease(OUTTO_DEV_TAG, files, {
    draft: false,
    prerelease: true,
    name: version ? `v${version}` : undefined,
  })
}

export async function runDesktopKeyboardDeploy(keyboardType: KeyboardType) {
  const allSecrets = await builder.secrets()
  const secrets = {
    awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
    awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
    pahkatApiKey: allSecrets.get("pahkat/apiKey"),
  }

  using tempDir = await makeTempDir()

  // Download artifacts from build step to temp directory based on platform
  if (keyboardType === KeyboardType.Windows) {
    await builder.downloadArtifacts("*.exe", tempDir.path)
  } else if (keyboardType === KeyboardType.MacOS) {
    await builder.downloadArtifacts("*.pkg", tempDir.path)
  }

  const bundlePath = await builder.metadata("bundle-path")

  let payloadPath: string | null = null
  let channel: string | null = null
  let version: string

  if (keyboardType === KeyboardType.Windows) {
    payloadPath = await globOneFile("**/*.exe", { root: tempDir.path })
    channel = await builder.metadata("windows-channel") || null
    version = await builder.metadata("windows-version")
    logger.debug(`Deploying Windows keyboard: ${payloadPath}`)
  } else if (keyboardType === KeyboardType.MacOS) {
    payloadPath = await globOneFile("**/*.pkg", { root: tempDir.path })
    channel = await builder.metadata("macos-channel") || null
    version = await builder.metadata("macos-version")
    logger.debug(`Deploying macOS keyboard: ${payloadPath}`)
  } else {
    throw new Error(`Unsupported keyboard type: ${keyboardType}`)
  }

  if (!payloadPath) {
    throw new Error(`No ${keyboardType} keyboard artifact found for deployment`)
  }

  if (!version) {
    throw new Error(
      `No version metadata found for ${keyboardType} keyboard deployment`,
    )
  }

  logger.debug(`- Bundle path: ${bundlePath}`)
  logger.debug(`- Channel: ${channel}`)
  logger.debug(`- Version: ${version}`)

  await keyboardDeploy({
    packageId: builder.env.repoName,
    keyboardType,
    bundlePath,
    channel,
    version,
    pahkatRepo: "https://pahkat.uit.no/main/",
    payloadPath,
    secrets,
  })

  logger.info(`${keyboardType} keyboard deployment completed`)
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export function pipelineDivvunKeyboard() {
  const pipeline: BuildkitePipeline = {
    steps: [
      command({
        label: "Build Divvun Keyboard for iOS",
        command: "divvun-actions run divvun-keyboard-ios",
        agents: {
          queue: "macos",
        },
      }),
      command({
        label: "Build Divvun Keyboard for Android",
        command: "divvun-actions run divvun-keyboard-android",
        agents: {
          queue: "linux",
        },
      }),
    ],
  }

  return pipeline
}

/** The kbdgen bundle of a `keyboard-<name>` repository, `<name>.kbdgen`. */
export function desktopKeyboardBundlePath(): string {
  return builder.env.repoName.split("-")[1] + ".kbdgen"
}

/** A top-level `format: 4`, matched rather than parsed so it cannot throw. */
const FORMAT_4 = /^format:\s*4\s*(?:#.*)?$/m

/**
 * Whether any of the bundle's layouts is format 4, which only kbdgen v4
 * reads. Pipelines are generated in the checkout; an unreadable bundle is
 * left to the production steps, as before.
 */
function isFormat4Bundle(bundlePath: string): boolean {
  const layoutsDir = path.join(bundlePath, "layouts")
  try {
    return [...Deno.readDirSync(layoutsDir)].some((entry) =>
      entry.isFile && entry.name.endsWith(".yaml") &&
      FORMAT_4.test(Deno.readTextFileSync(path.join(layoutsDir, entry.name)))
    )
  } catch {
    return false
  }
}

/** What a kbdgen v4 build's installer name adds to the repository's name. */
const KBDGEN_V4_PACKAGE_SUFFIX = "-kbdgen-v4-outto"

/**
 * The branch whose kbdgen v4 builds are published: keyboard-vro's format 4
 * bundle lives on `v4`. The "kbdgen v4 (test)" group builds every branch of
 * a format 4 bundle, but only pushes to this one deploy.
 */
const KBDGEN_V4_PUBLISH_BRANCH = "v4"

/**
 * The prerelease of the keyboard's repository that kbdgen v4 installers are
 * published to. Each build adds its installer under a name with its own
 * version and none is deleted, so the URL of every nightly pahkat release
 * stays valid. main replaces production's dev-latest, a release of its own.
 */
const KBDGEN_V4_RELEASE_TAG = "v4-nightly"

/** A push to KBDGEN_V4_PUBLISH_BRANCH, outside a pull request and a tag. */
function isKbdgenV4Publish(): boolean {
  if (builder.env.pullRequest && builder.env.pullRequest !== "false") {
    return false
  }
  return !builder.env.tag && builder.env.branch === KBDGEN_V4_PUBLISH_BRANCH
}

/**
 * Publishes the signed installer of a kbdgen v4 build: adds it to the
 * KBDGEN_V4_RELEASE_TAG prerelease of the keyboard's repository and makes
 * that asset's download URL the Windows payload of a nightly release of the
 * keyboard's pahkat package, the one production deploys to.
 */
export async function runDesktopKeyboardDeployWindowsV4() {
  if (!isKbdgenV4Publish()) {
    throw new Error(
      `kbdgen v4 keyboards are deployed from pushes to ` +
        `${KBDGEN_V4_PUBLISH_BRANCH} only`,
    )
  }

  using tempDir = await makeTempDir()
  await builder.downloadArtifacts(
    `*${KBDGEN_V4_PACKAGE_SUFFIX}_*_windows*.exe`,
    tempDir.path,
  )
  const files = await globFiles("*.exe", { root: tempDir.path })
  if (files.length !== 1) {
    throw new Error(`Expected one kbdgen v4 installer, found ${files.length}`)
  }
  const payloadPath = files[0]
  const assetName = path.basename(payloadPath)
  if (assetName.includes(".UNSIGNED.")) {
    throw new Error(`Refusing to publish unsigned installer: ${assetName}`)
  }

  const bundlePath = await builder.metadata("bundle-path")
  const version = await builder.metadata("windows-version")
  const channel = await builder.metadata("windows-channel")
  if (channel !== NIGHTLY_CHANNEL) {
    throw new Error(
      `kbdgen v4 keyboards are deployed to pahkat's ${NIGHTLY_CHANNEL} ` +
        `channel only, not "${channel}"`,
    )
  }

  const buildNumber = builder.env.buildNumber
  const releaseName = buildNumber
    ? `v${version} (build ${buildNumber})`
    : `v${version}`
  logger.info(
    `Publishing ${assetName} to ${KBDGEN_V4_RELEASE_TAG} as ${releaseName}`,
  )
  const gh = new GitHub(builder.env.repo)
  await gh.updateRelease(KBDGEN_V4_RELEASE_TAG, [payloadPath], {
    draft: false,
    prerelease: true,
    name: releaseName,
    keepAssets: true,
  })
  const artifactUrl = await gh.releaseAssetUrl(
    KBDGEN_V4_RELEASE_TAG,
    assetName,
  )
  logger.info(`Registering ${artifactUrl} with pahkat (${channel})`)

  const allSecrets = await builder.secrets()
  await keyboardDeploy({
    packageId: builder.env.repoName,
    keyboardType: KeyboardType.Windows,
    bundlePath,
    channel,
    version,
    pahkatRepo: "https://pahkat.uit.no/main/",
    payloadPath,
    artifactUrl,
    installer: "outto",
    secrets: {
      awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
      awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
      pahkatApiKey: allSecrets.get("pahkat/apiKey"),
    },
  })
}

/**
 * The outto Windows installer built with kbdgen v4, its text service and
 * kbdi with text service profiles (actions/keyboard/build/toolchain.ts),
 * uploaded as a build artifact. Pushes to KBDGEN_V4_PUBLISH_BRANCH also
 * deploy it (runDesktopKeyboardDeployWindowsV4).
 */
function kbdgenV4Group(): GroupStep {
  const steps: CommandStep[] = [
    command({
      label: "Build Windows keyboard with kbdgen v4 (outto)",
      key: "build-windows-kbdgen-v4-outto",
      command: "divvun-actions run divvun-keyboard-windows-v4 outto",
      agents: {
        queue: "windows",
      },
    }),
  ]
  if (isKbdgenV4Publish()) {
    steps.push(command({
      label: `Deploy (${KBDGEN_V4_RELEASE_TAG}, pahkat ${NIGHTLY_CHANNEL})`,
      command: "divvun-actions run divvun-keyboard-deploy-windows-v4",
      depends_on: "build-windows-kbdgen-v4-outto",
      agents: {
        queue: "linux",
      },
      // Two builds adding to the release at once could both try to create it.
      concurrency: 1,
      concurrency_group: `${builder.env.repoName}/kbdgen-v4-deploy`,
    }))
  }
  return {
    group: "kbdgen v4 (test)",
    key: "kbdgen-v4",
    steps,
  }
}

export function pipelineDesktopKeyboard() {
  // Production kbdgen cannot read a format 4 bundle, so such a bundle gets
  // only the kbdgen v4 builds.
  if (isFormat4Bundle(desktopKeyboardBundlePath())) {
    const pipeline: BuildkitePipeline = { steps: [kbdgenV4Group()] }
    return pipeline
  }

  // Only main publishes to the rolling dev-latest release; a branch build
  // would otherwise overwrite its assets with a one-off.
  const isMain = builder.env.branch === "main"

  const outtoSteps: CommandStep[] = [
    command({
      label: "Build Divvun Keyboard for Windows (outto)",
      key: "build-windows-outto",
      command: "divvun-actions run divvun-keyboard-windows outto",
      soft_fail: true,
      agents: {
        queue: "windows",
      },
    }),
    command({
      label: "Build Divvun Keyboard for macOS (outto)",
      key: "build-macos-outto",
      command: "divvun-actions run divvun-keyboard-macos outto",
      soft_fail: true,
      agents: {
        queue: "macos",
      },
    }),
  ]

  if (isMain) {
    outtoSteps.push(
      command({
        label: `Deploy outto installers (${OUTTO_DEV_TAG})`,
        command: "divvun-actions run divvun-keyboard-deploy-outto",
        // The builds are soft_fail, so this still runs when one platform did
        // not produce an installer. It publishes whatever did build and fails
        // only when nothing signed came out of either.
        depends_on: ["build-windows-outto", "build-macos-outto"],
        agents: {
          queue: "linux",
        },
      }),
    )
  }

  const pipeline: BuildkitePipeline = {
    steps: [
      // TODO: 2025-09-04 re-enable this once windows bundling components are updated.
      // This is turned off for now because it currently creates an installer that appears
      // to work, but does not actually install a keyboard on Win10/Win11.
      // command({
      //   label: "Build Divvun Keyboard for Windows",
      //   key: "build-windows",
      //   command: "divvun-actions run divvun-keyboard-windows",
      //   agents: {
      //     queue: "windows",
      //   },
      // }),
      // command({
      //   label: "Deploy Windows",
      //   command: "divvun-actions run divvun-keyboard-deploy-windows",
      //   depends_on: "build-windows",
      //   agents: {
      //     queue: "linux",
      //   },
      // }),
      command({
        label: "Build Divvun Keyboard for macOS",
        key: "build-macos",
        command: "divvun-actions run divvun-keyboard-macos",
        agents: {
          queue: "macos",
        },
      }),
      command({
        label: "Deploy macOS",
        command: "divvun-actions run divvun-keyboard-deploy-macos",
        depends_on: "build-macos",
        agents: {
          queue: "linux",
        },
      }),
      // Side group: outto builds, plus the dev-latest publish on main. Still
      // isolated from the legacy Pahkat build/deploy chain — group key "outto"
      // is intentionally not used in any depends_on outside this group, and
      // the builds stay soft_fail so an outto regression cannot redden a
      // keyboard build.
      {
        group: "Outto",
        key: "outto",
        steps: outtoSteps,
      },
    ],
  }

  return pipeline
}
