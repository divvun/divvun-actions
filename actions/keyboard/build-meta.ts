import * as builder from "~/builder.ts"
import { Kbdgen } from "~/util/shared.ts"
import { KeyboardType } from "./types.ts"

export type Props = {
  keyboardType: KeyboardType
  bundlePath: string
}

export type Output = {
  payloadPath: string
}

export default async function keyboardBuildMeta({
  keyboardType,
  bundlePath,
}: Props) {
  if (
    keyboardType !== KeyboardType.iOS &&
    keyboardType !== KeyboardType.Android
  ) {
    throw new Error(`Unsupported keyboard type for meta build: ${keyboardType}`)
  }

  await Kbdgen.fetchMetaBundle(bundlePath)
  let payloadPath

  let buildStart = 0
  const githubRepo = builder.env.repoPath

  if (githubRepo === "divvun/divvun-keyboard") {
    if (keyboardType === KeyboardType.Android) {
      buildStart = 1590918851
    }
  } else if (githubRepo === "divvun/divvun-dev-keyboard") {
    // Do nothing
  } else {
    throw new Error(`Unsupported repository for release builds: ${githubRepo}`)
  }

  const secrets = await builder.secrets()

  if (keyboardType === KeyboardType.Android) {
    await Kbdgen.setBuildNumber(bundlePath, "android", buildStart)
    payloadPath = await Kbdgen.buildAndroid(bundlePath, {
      githubUsername: secrets.get("github/username"),
      githubToken: secrets.get("github/token"),
      keyStore: secrets.get("android/keyStore"),
      keyAlias: secrets.get("android/keyAlias"),
      storePassword: secrets.get("android/keyStorePassword"),
      keyPassword: secrets.get("android/keyPassword"),
      playStoreP12: secrets.get("android/playStoreP12"),
      playStoreAccount: secrets.get("android/playStoreAccount"),
    })
  } else if (keyboardType === KeyboardType.iOS) {
    await Kbdgen.setBuildNumber(bundlePath, "ios", buildStart)
    console.log("Building iOS")
    payloadPath = await Kbdgen.build_iOS(bundlePath, {
      githubUsername: secrets.get("github/username"),
      githubToken: secrets.get("github/token"),
      matchGitUrl: secrets.get("ios/matchGitUrl"),
      matchPassword: secrets.get("ios/matchPassword"),
      fastlaneUser: secrets.get("ios/fastlaneUser"),
      fastlanePassword: secrets.get("ios/fastlanePassword"),
      appStoreKeyJson: secrets.get("macos/appStoreKeyJson"),
      adminPassword: secrets.get("macos/adminPassword"),
    })
  }

  // In general, this will be unused, because iOS and Android builds are
  // submitted directly to their respective app stores.
  // await builder.setOutput("payload-path", payloadPath)

  return { payloadPath }
}

// async function run() {
//   const keyboardType = (await builder.getInput("keyboard-type", {
//     required: true,
//   })) as KeyboardType
//   const bundlePath = await builder.getInput("bundle-path", { required: true })

//   await keyboardBuildMeta({ keyboardType, bundlePath })
// }
