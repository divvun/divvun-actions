import {
  fastlanePilotUpload,
  FastlanePilotUploadApiKey,
} from "~/actions/fastlane/pilot.ts"
import keyboardBuildMeta from "~/actions/keyboard/build-meta.ts"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"

async function apiKey(): Promise<FastlanePilotUploadApiKey> {
  const secrets = await builder.secrets()

  return {
    key_id: secrets.get("macos/apiKey/key_id"),
    issuer_id: secrets.get("macos/apiKey/issuer_id"),
    key: secrets.get("macos/apiKey/key"),
    duration: parseInt(secrets.get("macos/apiKey/duration"), 10),
    in_house: secrets.get("macos/apiKey/in_house") === "true",
  }
}

export async function runDivvunKeyboard(kbdgenBundlePath: string) {
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
      await fastlanePilotUpload({
        apiKey: await apiKey(),
        ipaPath: "output/ipa/HostingApp.ipa",
      })
    })
  } else {
    logger.info("Not main branch; skipping upload")
  }
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

  console.log(pipeline)

  return pipeline
}
