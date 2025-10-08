import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { DisposablePath, makeTempDir } from "../util/temp.ts"

export default async function sign(
  inputFile: string,
  version: string,
  entitlementsPath?: string,
) {
  const secrets = await builder.secrets()
  const codeSignId = secrets.get("macos/appCodeSignId")

  await builder.exec("security", ["find-identity", "-v", "-p", "codesigning"])
  await builder.exec("security", [
    "unlock-keychain",
    "-p",
    "admin",
    "/Users/admin/Library/Keychains/login.keychain-db",
  ])

  // Update the version to the one provided by the build system
  await builder.exec("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :CFBundleShortVersionString ${version}`,
    path.join(inputFile, "Contents/Info.plist"),
  ])

  const codeSignArgs = []

  if (entitlementsPath) {
    console.log("Using entitlements from:", entitlementsPath)
    codeSignArgs.push("--entitlements", entitlementsPath)
  } else {
    console.log("No entitlements provided, skipping")
  }

  const result = await builder.output("timeout", [
    "60s",
    "xcrun",
    "codesign",
    "--options=runtime",
    ...codeSignArgs,
    "-f",
    "--deep",
    "-s",
    codeSignId,
    inputFile,
  ])

  if (result.status.code !== 0) {
    throw new Error(
      `bundle signing failed: ${result.stderr}\nexit code: ${result.status.code}`,
    )
  }

  console.log("Signed:", result.stdout)

  using uploadDir = await makeTempDir()
  const uploadPath = path.join(
    uploadDir.path,
    `divvun-rt-playground-${version}.app.zip`,
  )

  await builder.exec("/usr/bin/ditto", [
    "-c",
    "-k",
    "--keepParent",
    inputFile,
    uploadPath,
  ])
  console.log("Created zip for notarization:", uploadPath)

  await notarize(uploadPath)

  console.log("Stapling notarization ticket...")
  const stapleResult = await builder.output("xcrun", [
    "stapler",
    "staple",
    inputFile,
  ])

  if (stapleResult.status.code !== 0) {
    throw new Error(
      `stapling failed: ${stapleResult.stderr}\nexit code: ${stapleResult.status.code}`,
    )
  }

  console.log("Stapled:", stapleResult.stdout)

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

async function notarize(inputFile: string) {
  const secrets = await builder.secrets()

  const appStoreKey: {
    key_id: string
    issuer_id: string
    key: string
  } = JSON.parse(secrets.get("macos/appStoreKeyJson"))

  using notarytool = await NotaryTool.create(appStoreKey)
  // Retry up to 3 times
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const submitResult = await notarytool.submit(inputFile)
      console.log("Notarization submitted:", submitResult)
      return
    } catch (error) {
      lastError = error as Error
      console.warn(`Notarization attempt ${attempt}/3 failed:`, error)
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }

  throw new Error(`Notarization failed after 3 attempts: ${lastError?.message}`)
}

class NotaryTool {
  #keyId: string
  #issuerId: string
  #keyPath: DisposablePath

  static async create(keyJson: {
    key_id: string
    issuer_id: string
    key: string
  }) {
    const tmpDir = await makeTempDir()
    const keyPath = path.join(tmpDir.path, "key.p8")
    await Deno.writeFile(keyPath, new TextEncoder().encode(keyJson.key))
    return new NotaryTool(keyJson.key_id, keyJson.issuer_id, tmpDir)
  }

  private constructor(
    keyId: string,
    issuerId: string,
    keyPath: DisposablePath,
  ) {
    this.#keyId = keyId
    this.#issuerId = issuerId
    this.#keyPath = keyPath
  }

  [Symbol.dispose]() {
    this.#keyPath[Symbol.dispose]()
  }

  async #notarytool(command: string, args: string[] = []) {
    return await builder.output("xcrun", [
      "notarytool",
      command,
      "-d",
      this.#keyId,
      "-i",
      this.#issuerId,
      "-k",
      path.join(this.#keyPath.path, "key.p8"),
      "-f",
      "json",
      ...args,
    ])
  }

  async history(): Promise<HistoryResponse> {
    const result = await this.#notarytool("history")

    if (result.status.code !== 0) {
      throw new Error(
        `notarytool history failed: ${result.stderr}\nexit code: ${result.status.code}`,
      )
    }

    return JSON.parse(result.stdout) as HistoryResponse
  }

  async submit(inputFile: string): Promise<any> {
    const result = await this.#notarytool("submit", [
      "--no-s3-acceleration",
      "--wait",
      inputFile,
    ])

    if (result.status.code !== 0) {
      throw new Error(
        `notarytool submit failed: ${result.stderr}\nexit code: ${result.status.code}`,
      )
    }

    return JSON.parse(result.stdout)
  }

  async info(uuid: string): Promise<any> {
    const result = await this.#notarytool("info", [uuid])

    if (result.status.code !== 0) {
      throw new Error(
        `notarytool info failed: ${result.stderr}\nexit code: ${result.status.code}`,
      )
    }

    return JSON.parse(result.stdout)
  }
}

type HistoryResponse = {
  history: Array<{
    name: string
    id: string
    status: string
    createdDate: string
  }>
  message: string
}
