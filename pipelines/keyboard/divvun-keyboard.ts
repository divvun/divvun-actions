import * as fs from "@std/fs"
import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import keyboardBuildMeta from "~/actions/keyboard/build-meta.ts"
import keyboardBuild from "~/actions/keyboard/build/mod.ts"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import keyboardDeploy from "../../actions/keyboard/deploy.ts"
import { sentryUploadIOSDebugFiles } from "../../actions/sentry/upload-debug-files.ts"
import { Kbdgen, versionAsNightly } from "../../util/shared.ts"

export async function runDivvunKeyboardIOS(kbdgenBundlePath: string) {
  const secrets = await builder.secrets()
  // await builder.group("Initializing Pahkat", async () => {
  //   await pahkatInit({
  //     repoUrl: "https://pahkat.uit.no/devtools/",
  //     channel: "nightly",
  //     packages: ["kbdgen"],
  //   })
  // })

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
): Promise<string> {
  using tempDir = await makeTempDir()

  // Get version from kbdgen bundle
  const target = await Kbdgen.loadTarget(bundlePath, "windows")
  const baseVersion = target.version as string

  // Apply channel and timestamp if this is a nightly build
  const version = channel ? await versionAsNightly(baseVersion) : baseVersion

  const pathItems = [packageId, version, "windows"]
  const packageFileName = `${pathItems.join("_")}.exe`
  const packagePath = path.join(tempDir.path, packageFileName)

  await Deno.copyFile(payloadPath, packagePath)
  return packagePath
}

export async function runDesktopKeyboardWindows(kbdgenBundlePath: string) {
  logger.info("Building Divvun Keyboard for Windows")

  const { payloadPath, channel } = await keyboardBuild({
    keyboardType: KeyboardType.Windows,
    bundlePath: kbdgenBundlePath,
  })

  const artifactPath = await createWindowsPackage(
    payloadPath,
    builder.env.repoName,
    kbdgenBundlePath,
    channel,
  )

  // Upload artifact for later deployment
  await builder.uploadArtifacts(artifactPath)

  // Get the full version (including nightly timestamp) from the artifact
  const target = await Kbdgen.loadTarget(kbdgenBundlePath, "windows")
  const baseVersion = target.version as string
  const fullVersion = channel
    ? await versionAsNightly(baseVersion)
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

  // Apply channel and timestamp if this is a nightly build
  const version = channel ? await versionAsNightly(baseVersion) : baseVersion

  const pathItems = [packageId, version, "macos"]
  const packageFileName = `${pathItems.join("_")}.pkg`
  const packagePath = path.join(tempDir.path, packageFileName)

  await Deno.copyFile(payloadPath, packagePath)
  return packagePath
}

export async function runDesktopKeyboardMacOS(kbdgenBundlePath: string) {
  logger.info("Building Divvun Keyboard for macOS")

  const { payloadPath, channel } = await keyboardBuild({
    keyboardType: KeyboardType.MacOS,
    bundlePath: kbdgenBundlePath,
  })

  // Create properly named package
  const artifactPath = await createMacosPackage(
    payloadPath,
    builder.env.repoName,
    kbdgenBundlePath,
    channel,
  )

  await builder.uploadArtifacts(artifactPath)

  // Get the full version (including nightly timestamp) from the artifact
  const target = await Kbdgen.loadTarget(kbdgenBundlePath, "macos")
  const baseVersion = target.version as string
  const fullVersion = channel
    ? await versionAsNightly(baseVersion)
    : baseVersion

  // Store metadata for deployment
  await builder.setMetadata("macos-channel", channel || "")
  await builder.setMetadata("macos-version", fullVersion)
  await builder.setMetadata("bundle-path", kbdgenBundlePath)

  logger.info("macOS keyboard built and artifact uploaded")
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

  // Find downloaded artifacts using glob patterns in temp directory
  async function globOneFile(pattern: string): Promise<string | null> {
    const files = await fs.expandGlob(pattern, { root: tempDir.path })
    for await (const file of files) {
      if (file.isFile) {
        return file.path
      }
    }
    return null
  }

  let payloadPath: string | null = null
  let channel: string | null = null
  let version: string

  if (keyboardType === KeyboardType.Windows) {
    payloadPath = await globOneFile("**/*.exe")
    channel = await builder.metadata("windows-channel") || null
    version = await builder.metadata("windows-version")
    logger.debug(`Deploying Windows keyboard: ${payloadPath}`)
  } else if (keyboardType === KeyboardType.MacOS) {
    payloadPath = await globOneFile("**/*.pkg")
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
    ],
  }

  return pipeline
}
