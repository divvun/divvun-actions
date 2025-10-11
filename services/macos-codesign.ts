import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeTempDir } from "../util/temp.ts"

export default async function sign(
  inputFile: string,
  version: string,
  entitlementsPath?: string,
) {
  using tempDir = await makeTempDir({ prefix: "rcodesign-" })
  
  const pemFile = path.join(tempDir.path, "devid.pem")
  const keyJson = path.join(tempDir.path, "key.json")

  const secrets = await builder.secrets()
  await Deno.writeTextFile(pemFile, secrets.get("macos/appPem"))
  await Deno.writeTextFile(keyJson, secrets.get("macos/rcodesignKeyJson"))

  // Update the version to the one provided by the build system
  await builder.exec("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :CFBundleShortVersionString ${version}`,
    path.join(inputFile, "Contents/Info.plist"),
  ])

  const codeSignArgs = []

  if (entitlementsPath) {
    console.log("Using entitlements from:", entitlementsPath)
    codeSignArgs.push("-e", entitlementsPath)
  } else {
    console.log("No entitlements provided, skipping")
  }

  await builder.exec("rcodesign", [
    "sign",
    "--pem-file",
    pemFile,
    "--for-notarization",
    ...codeSignArgs,
    inputFile,
  ])

  await notarize(inputFile, keyJson)

  const assessResult = await builder.output("spctl", [
    "--assess",
    "-vv",
    inputFile,
  ])

  if (assessResult.status.code !== 0) {
    throw new Error(
      `spctl failed: ${assessResult.stderr}\nexit code: ${assessResult.status.code}`,
    )
  }

  console.log("spctl:", assessResult.stdout)
}

async function notarize(inputFile: string, keyJson: string) {
  await builder.exec("rcodesign", [
    "notary-submit",
    "--api-key-file",
    keyJson,
    "--wait",
    "--staple",
    inputFile,
  ])
}
