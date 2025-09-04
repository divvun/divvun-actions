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
import { Kbdgen } from "../../util/shared.ts"

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
): Promise<string> {
  using tempDir = await makeTempDir()

  // Get version from kbdgen bundle (after setNightlyVersion has been called)
  const target = await Kbdgen.loadTarget(bundlePath, "windows")
  const version = target.version as string

  const pathItems = [packageId, version, "windows"]
  const packageFileName = `${pathItems.join("_")}.exe`
  const packagePath = path.join(tempDir.path, packageFileName)

  await Deno.copyFile(payloadPath, packagePath)
  return packagePath
}

export async function runDesktopKeyboardWindows(kbdgenBundlePath: string) {
  await builder.group("Building Divvun Keyboard for Windows", async () => {
    const { payloadPath, channel } = await keyboardBuild({
      keyboardType: KeyboardType.Windows,
      nightlyChannel: "nightly",
      bundlePath: kbdgenBundlePath,
    })

    const artifactPath = await createWindowsPackage(
      payloadPath,
      builder.env.repoName,
      kbdgenBundlePath,
    )

    // Upload artifact for later deployment
    await builder.uploadArtifacts(artifactPath)

    // Store metadata for deployment
    await builder.setMetadata("windows-channel", channel || "")
    await builder.setMetadata("bundle-path", kbdgenBundlePath)

    logger.info("Windows keyboard built and artifact uploaded")
  })
}

async function createMacosPackage(
  payloadPath: string,
  packageId: string,
  bundlePath: string,
): Promise<string> {
  using tempDir = await makeTempDir()

  // Get version from kbdgen bundle (after setNightlyVersion has been called)
  const target = await Kbdgen.loadTarget(bundlePath, "macos")
  const version = target.version as string

  // Create properly named package
  const pathItems = [packageId, version, "macos"]
  const packageFileName = `${pathItems.join("_")}.pkg`
  const packagePath = path.join(tempDir.path, packageFileName)

  await Deno.copyFile(payloadPath, packagePath)
  return packagePath
}

export async function runDesktopKeyboardMacOS(kbdgenBundlePath: string) {
  await builder.group("Building Divvun Keyboard for macOS", async () => {
    logger.info("Building Divvun Keyboard for macOS")
    const { payloadPath, channel } = await keyboardBuild({
      keyboardType: KeyboardType.MacOS,
      nightlyChannel: "nightly",
      bundlePath: kbdgenBundlePath,
    })

    // Create properly named package
    const artifactPath = await createMacosPackage(
      payloadPath,
      builder.env.repoName,
      kbdgenBundlePath,
    )

    // Upload artifact for later deployment
    await builder.uploadArtifacts(artifactPath)

    // Store metadata for deployment
    await builder.setMetadata("macos-channel", channel || "")
    await builder.setMetadata("bundle-path", kbdgenBundlePath)

    logger.info("macOS keyboard built and artifact uploaded")
  })
}

export async function runDesktopKeyboardDeploy() {
  const allSecrets = await builder.secrets()
  const secrets = {
    awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
    awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
    pahkatApiKey: allSecrets.get("pahkat/apiKey"),
  }

  // Use temp directory for downloading artifacts
  using tempDir = await makeTempDir()

  // Download all artifacts from build steps to temp directory
  await builder.downloadArtifacts("*.exe", tempDir.path)
  await builder.downloadArtifacts("*.pkg", tempDir.path)

  // Get metadata from build steps
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

  const windowsFiles = await globOneFile("**/*.exe")
  const macosFiles = await globOneFile("**/*.pkg")

  console.log("Deploying keyboard files:")
  console.log(`- Windows: ${windowsFiles}`)
  console.log(`- macOS: ${macosFiles}`)
  console.log(`- Bundle path: ${bundlePath}`)

  // Deploy Windows keyboard if available
  if (windowsFiles) {
    const windowsChannel = await builder.metadata("windows-channel")
    await keyboardDeploy({
      packageId: builder.env.repoName,
      keyboardType: KeyboardType.Windows,
      bundlePath,
      channel: windowsChannel || null,
      pahkatRepo: "https://pahkat.uit.no/main/",
      payloadPath: windowsFiles,
      secrets,
    })
  }

  // Deploy macOS keyboard if available
  if (macosFiles) {
    const macosChannel = await builder.metadata("macos-channel")
    await keyboardDeploy({
      packageId: builder.env.repoName,
      keyboardType: KeyboardType.MacOS,
      bundlePath,
      channel: macosChannel || null,
      pahkatRepo: "https://pahkat.uit.no/main/",
      payloadPath: macosFiles,
      secrets,
    })
  }

  logger.info("Keyboard deployment completed")
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
      {
        group: "Build",
        key: "build",
        steps: [
          command({
            label: "Build Divvun Keyboard for Windows",
            command: "divvun-actions run divvun-keyboard-windows",
            agents: {
              queue: "windows",
            },
          }),
          command({
            label: "Build Divvun Keyboard for macOS",
            command: "divvun-actions run divvun-keyboard-macos",
            agents: {
              queue: "macos",
            },
          }),
        ],
      },
      command({
        label: "Deploy",
        command: "divvun-actions run divvun-keyboard-deploy",
        depends_on: "build",
        agents: {
          queue: "linux",
        },
      }),
    ],
  }

  return pipeline
}
