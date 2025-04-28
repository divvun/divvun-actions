import {
    fastlanePilotUpload,
    FastlanePilotUploadApiKey,
} from "~/actions/fastlane/pilot.ts"
import keyboardBuildMeta from "~/actions/keyboard/build-meta.ts"
import { KeyboardType } from "~/actions/keyboard/types.ts"
import pahkatInit from "~/actions/pahkat/init.ts"
import * as builder from "~/builder.ts"
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
  await pahkatInit({
    repoUrl: "https://pahkat.uit.no/devtools/",
    channel: "nightly",
    packages: ["kbdgen"],
  })

  await keyboardBuildMeta({
    keyboardType: KeyboardType.iOS,
    bundlePath: kbdgenBundlePath,
  })

  if (builder.env.branch === "main") {
    await fastlanePilotUpload({
      apiKey: await apiKey(),
      ipaPath: "output/ipa/HostingApp.ipa",
    })
  } else {
    logger.info("Not main branch; skipping upload")
  }
}
