import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import keyboardBuildMeta from "~/actions/keyboard/build-meta.ts"
import keyboardBuild from "~/actions/keyboard/build/mod.ts"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import keyboardDeploy from "../../actions/keyboard/deploy.ts"
import { sentryUploadIOSDebugFiles } from "../../actions/sentry/upload-debug-files.ts"

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

export async function runDesktopKeyboardWindows(kbdgenBundlePath: string) {
  await builder.group("Building Divvun Keyboard for Windows", async () => {
    const { payloadPath, channel } = await keyboardBuild({
      keyboardType: KeyboardType.Windows,
      nightlyChannel: "nightly",
      bundlePath: kbdgenBundlePath,
    })

    // Upload artifact for later deployment
    await builder.uploadArtifact(payloadPath)
    
    // Store metadata for deployment
    await builder.setMetadata("windows-payload-path", payloadPath)
    await builder.setMetadata("windows-channel", channel || "")
    await builder.setMetadata("bundle-path", kbdgenBundlePath)
    
    logger.info("Windows keyboard built and artifact uploaded")
  })
}

export async function runDesktopKeyboardMacOS(kbdgenBundlePath: string) {
  await builder.group("Building Divvun Keyboard for macOS", async () => {
    logger.info("Building Divvun Keyboard for macOS")
    const { payloadPath, channel } = await keyboardBuild({
      keyboardType: KeyboardType.MacOS,
      nightlyChannel: "nightly",
      bundlePath: kbdgenBundlePath,
    })

    // Upload artifact for later deployment
    await builder.uploadArtifact(payloadPath)
    
    // Store metadata for deployment
    await builder.setMetadata("macos-payload-path", payloadPath)
    await builder.setMetadata("macos-channel", channel || "")
    if (!await builder.metadata("bundle-path")) {
      await builder.setMetadata("bundle-path", kbdgenBundlePath)
    }
    
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

  // Download all artifacts from build steps
  await builder.downloadArtifacts("*.exe", ".")
  await builder.downloadArtifacts("*.pkg", ".")
  
  // Get metadata from build steps
  const bundlePath = await builder.metadata("bundle-path")
  
  // Find and deploy Windows installer
  const windowsFiles = []
  for await (const entry of Deno.readDir(".")) {
    if (entry.isFile && entry.name.endsWith(".exe")) {
      windowsFiles.push(entry.name)
    }
  }
  
  // Find and deploy macOS installer  
  const macosFiles = []
  for await (const entry of Deno.readDir(".")) {
    if (entry.isFile && entry.name.endsWith(".pkg")) {
      macosFiles.push(entry.name)
    }
  }

  console.log("Deploying keyboard files:")
  console.log(`- Windows: ${windowsFiles}`)
  console.log(`- macOS: ${macosFiles}`)
  console.log(`- Bundle path: ${bundlePath}`)

  // Deploy Windows keyboard if available
  if (windowsFiles.length > 0) {
    const windowsChannel = await builder.metadata("windows-channel")
    await keyboardDeploy({
      packageId: builder.env.repoName,
      keyboardType: KeyboardType.Windows,
      bundlePath,
      channel: windowsChannel || null,
      pahkatRepo: "https://pahkat.uit.no/main/",
      payloadPath: windowsFiles[0],
      secrets,
    })
  }

  // Deploy macOS keyboard if available
  if (macosFiles.length > 0) {
    const macosChannel = await builder.metadata("macos-channel")
    await keyboardDeploy({
      packageId: builder.env.repoName,
      keyboardType: KeyboardType.MacOS,
      bundlePath,
      channel: macosChannel || null,
      pahkatRepo: "https://pahkat.uit.no/main/",
      payloadPath: macosFiles[0],
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
