import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import keyboardBuildMeta from "~/actions/keyboard/build-meta.ts"
import keyboardBuild, {
  type InstallerKind,
} from "~/actions/keyboard/build/mod.ts"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { globOneFile } from "~/util/glob.ts"
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
  bundlePath: string,
  channel: string | null,
  unsigned: boolean,
): Promise<string> {
  using tempDir = await makeTempDir()

  // Get version from kbdgen bundle
  const target = await Kbdgen.loadTarget(bundlePath, "windows")
  const baseVersion = target.version as string

  // Apply channel and timestamp if this is a dev build
  const version = channel
    ? await versionAsNightly(baseVersion, builder.env.buildNumber)
    : baseVersion

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
) {
  logger.info(
    `Building Divvun Keyboard for Windows (installer: ${
      installer ?? "default"
    })`,
  )

  const { payloadPath, channel, unsigned } = await keyboardBuild({
    keyboardType: KeyboardType.Windows,
    bundlePath: kbdgenBundlePath,
    installer,
  })

  const artifactPath = await createWindowsPackage(
    payloadPath,
    builder.env.repoName,
    kbdgenBundlePath,
    channel,
    unsigned,
  )

  // Upload artifact for later deployment
  await builder.uploadArtifacts(artifactPath)

  // Get the full version (including dev timestamp) from the artifact
  const target = await Kbdgen.loadTarget(kbdgenBundlePath, "windows")
  const baseVersion = target.version as string
  const fullVersion = channel
    ? await versionAsNightly(baseVersion, builder.env.buildNumber)
    : baseVersion

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
  //   <repoName>_<version>_windows.exe     (.UNSIGNED.exe if signing failed)
  //   <repoName>_<version>_macos.app.zip
  // The legacy macOS build uploads a .pkg into this same build, so these
  // patterns must stay narrow enough to exclude it.
  await downloadOuttoArtifacts("*_windows.exe", tempDir.path)
  await downloadOuttoArtifacts("*_macos.app.zip", tempDir.path)

  const files: string[] = []
  for await (const entry of Deno.readDir(tempDir.path)) {
    if (!entry.isFile) continue
    // buildKeyboardWindowsOutto falls back to an unsigned installer rather than
    // failing the build. An unsigned installer on a public release is worse
    // than no installer, so drop it and say so loudly.
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

export function pipelineDesktopKeyboard() {
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
