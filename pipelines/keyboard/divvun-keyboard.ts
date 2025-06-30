import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import keyboardBuildMeta from "~/actions/keyboard/build-meta.ts"
import keyboardBuild from "~/actions/keyboard/build/mod.ts"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import keyboardDeploy from "../../actions/keyboard/deploy.ts"

export async function runDivvunKeyboard(kbdgenBundlePath: string) {
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

  await builder.group("Find dysm files and print their paths", async () => {
    const dsymFiles = await builder.output("find", ["output", "-name", "*.dSYM.zip"])
    if (dsymFiles.status.code !== 0) {
      logger.error("Failed to find dSYM files:", dsymFiles.stderr)
      throw new Error("Failed to find dSYM files")
    }
    const dsymPaths = dsymFiles.stdout.trim().split("\n").filter(Boolean)
    if (dsymPaths.length === 0) {
      logger.warning("No dSYM files found")
    } else {
      logger.info("Found dSYM files:", dsymPaths.join(", "))
    }
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
}

export async function runDesktopKeyboardWindows(kbdgenBundlePath: string) {
  await builder.group("Building Divvun Keyboard for Windows", async () => {
    const { payloadPath, channel } = await keyboardBuild({
      keyboardType: KeyboardType.Windows,
      nightlyChannel: "nightly",
      bundlePath: kbdgenBundlePath,
    })

    const secrets = await builder.secrets()

    await keyboardDeploy({
      packageId: builder.env.repoName,
      keyboardType: KeyboardType.Windows,
      bundlePath: kbdgenBundlePath,
      channel,
      pahkatRepo: "https://pahkat.uit.no/main/",
      payloadPath,
      secrets: {
        awsAccessKeyId: secrets.get("s3/accessKeyId"),
        awsSecretAccessKey: secrets.get("s3/secretAccessKey"),
        pahkatApiKey: secrets.get("pahkat/apiKey"),
      },
    })
    console.log(payloadPath, channel)
  })
}

export async function runDesktopKeyboardMacOS(kbdgenBundlePath: string) {
  await builder.group("Building Divvun Keyboard for macOS", async () => {
    console.log("Building Divvun Keyboard for macOS")
    await keyboardBuild({
      keyboardType: KeyboardType.MacOS,
      nightlyChannel: "nightly",
      bundlePath: kbdgenBundlePath,
    })
    console.log("Done building Divvun Keyboard for macOS")
  })
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
    ],
  }

  return pipeline
}

export function pipelineDesktopKeyboard() {
  const pipeline: BuildkitePipeline = {
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
  }

  return pipeline
}
