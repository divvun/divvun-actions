import { encodeBase64 } from "@std/encoding/base64"
import * as fs from "@std/fs"
import * as path from "@std/path"
import { fastlanePilotUpload } from "~/actions/fastlane/pilot.ts"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"
import type { SecretsStore } from "~/util/openbao.ts"

const BUNDLE_ID = "no.uit.divvun.donate-your-speech"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export function pipelineDonateSpeech(): BuildkitePipeline {
  const isMainBranch = builder.env.branch === "main"

  const pipeline: BuildkitePipeline = {
    steps: [
      command({
        label: "Build & Sign iOS",
        key: "build-ios",
        command: "divvun-actions run donate-speech-build-ios",
        agents: { queue: "macos" },
      }),
    ],
  }

  if (isMainBranch) {
    pipeline.steps.push(
      command({
        label: "Deploy iOS",
        command: "divvun-actions run donate-speech-deploy-ios",
        depends_on: "build-ios",
        agents: { queue: "macos" },
      }),
    )
  }

  return pipeline
}

export async function runDonateSpeechBuildIOS() {
  const secrets = await builder.secrets()

  let certificate: string
  let mobileProvision: string
  await builder.group("Fetching signing credentials from match", async () => {
    const credentials = await fetchMatchCredentials(secrets)
    certificate = credentials.certificate
    mobileProvision = credentials.mobileProvision
  })

  await builder.group("Installing dependencies", async () => {
    await builder.exec("pnpm", ["install", "--frozen-lockfile"])
  })

  await builder.group("Initializing iOS project", async () => {
    await builder.exec("pnpm", ["tauri", "ios", "init"])
  })

  await builder.group("Building iOS app", async () => {
    await builder.exec("pnpm", [
      "tauri",
      "ios",
      "build",
      "--export-method",
      "app-store-connect",
      "--config",
      "src-tauri/tauri.conf.release.json",
    ], {
      env: {
        IOS_CERTIFICATE: certificate!,
        IOS_CERTIFICATE_PASSWORD: "",
        IOS_MOBILE_PROVISION: mobileProvision!,
      },
    })
  })

  await builder.group("Uploading artifacts", async () => {
    const ipaPath = await findIpa()
    logger.info(`Found IPA: ${ipaPath}`)
    await builder.uploadArtifacts(ipaPath)
  })
}

export async function runDonateSpeechDeployIOS() {
  const secrets = await builder.secrets()

  using tempDir = await makeTempDir()

  await builder.group("Downloading artifacts", async () => {
    await builder.downloadArtifacts("**/*.ipa", tempDir.path)
  })

  await builder.group("Uploading to App Store Connect", async () => {
    const ipaPath = await findFile(path.join(tempDir.path, "**/*.ipa"))
    if (!ipaPath) {
      throw new Error("No IPA found in downloaded artifacts")
    }

    logger.info(`Uploading IPA: ${ipaPath}`)
    const apiKey = JSON.parse(secrets.get("macos/appStoreKeyJson"))
    await fastlanePilotUpload({
      apiKey,
      ipaPath,
    })
  })
}

async function fetchMatchCredentials(secrets: SecretsStore): Promise<{
  certificate: string
  mobileProvision: string
}> {
  using matchDir = await makeTempDir()

  // Clone the match repo
  const matchGitUrl = secrets.get("ios/matchGitUrl")
  await builder.exec("git", ["clone", "--depth", "1", matchGitUrl, matchDir.path])

  // Find the distribution certificate .p12
  const certDir = path.join(matchDir.path, "certs", "distribution")
  let certPath: string | null = null
  for await (const entry of fs.expandGlob(path.join(certDir, "*.p12"))) {
    certPath = entry.path
    break
  }
  if (!certPath) {
    throw new Error("No distribution certificate found in match repo")
  }

  // Find the provisioning profile
  const profilePath = path.join(
    matchDir.path,
    "profiles",
    "appstore",
    `AppStore_${BUNDLE_ID}.mobileprovision`,
  )

  const matchPassword = secrets.get("ios/matchPassword")
  const decryptedCert = await decryptMatchFile(certPath, matchPassword)
  const decryptedProfile = await decryptMatchFile(profilePath, matchPassword)

  return {
    certificate: encodeBase64(decryptedCert),
    mobileProvision: encodeBase64(decryptedProfile),
  }
}

async function decryptMatchFile(
  filePath: string,
  password: string,
): Promise<Uint8Array> {
  const output = await new Deno.Command("openssl", {
    args: [
      "enc",
      "-aes-256-cbc",
      "-d",
      "-a",
      "-md",
      "md5",
      "-pass",
      `pass:${password}`,
      "-in",
      filePath,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output()

  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr)
    throw new Error(`Failed to decrypt ${filePath}: ${stderr}`)
  }

  return output.stdout
}

async function findIpa(): Promise<string> {
  // Tauri iOS builds output the IPA under src-tauri/gen/apple/build/
  const searchPaths = [
    "src-tauri/gen/apple/build/**/*.ipa",
    "**/*.ipa",
  ]

  for (const pattern of searchPaths) {
    const result = await findFile(pattern)
    if (result) return result
  }

  throw new Error(
    "No IPA found. Searched: " + searchPaths.join(", "),
  )
}

async function findFile(pattern: string): Promise<string | null> {
  const files = await fs.expandGlob(pattern, { followSymlinks: false })
  for await (const file of files) {
    if (file.isFile) {
      return file.path
    }
  }
  return null
}
