import * as path from "@std/path"
import * as toml from "@std/toml"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import {
  getArtifactSize,
  nonUndefinedProxy,
  PahkatUploader,
  ReleaseRequest,
  versionAsNightly,
} from "~/util/shared.ts"

export function derivePackageId() {
  return "kbdgen"
}

async function loadCargoToml(): Promise<any> {
  const cargoString = await Deno.readTextFile("./Cargo.toml")
  return nonUndefinedProxy(toml.parse(cargoString), true)
}

function releaseReq(
  version: string,
  platform: string,
  channel: string | null,
): ReleaseRequest {
  const req: ReleaseRequest = {
    version,
    platform,
  }

  if (channel) {
    req.channel = channel
  }

  return req
}

export type Props = {
  payloadPath: string
  platform: string
  version: string
  channel: string | null
  pahkatRepo: string
  packageId: string
  secrets: {
    pahkatApiKey: string
    awsAccessKeyId: string
    awsSecretAccessKey: string
  }
}

export default async function kbdgenDeploy({
  payloadPath,
  platform,
  version,
  channel,
  pahkatRepo,
  packageId,
  secrets,
}: Props) {
  try {
    const repoPackageUrl = `${pahkatRepo}packages/${packageId}`

    const ext = path.extname(payloadPath)
    const pathItems = [packageId, version, platform]
    const artifactPath = path.join(
      path.dirname(payloadPath),
      `${pathItems.join("_")}${ext}`,
    )
    const artifactUrl = `${PahkatUploader.ARTIFACTS_URL}${
      path.basename(artifactPath)
    }`
    const artifactSize = getArtifactSize(payloadPath)

    const payloadMetadata = await PahkatUploader.release.tarballPackage(
      releaseReq(version, platform, channel),
      artifactUrl,
      1,
      artifactSize,
      secrets,
    )

    if (payloadMetadata == null) {
      throw new Error("Payload is null; this is a logic error.")
    }

    await Deno.writeTextFile("./metadata.toml", payloadMetadata)

    logger.debug(`Renaming from ${payloadPath} to ${artifactPath}`)
    await Deno.rename(payloadPath, artifactPath)

    await PahkatUploader.upload(
      artifactPath,
      artifactUrl,
      "./metadata.toml",
      repoPackageUrl,
      secrets,
      {
        packageType: "executable",
      },
    )
  } catch (error: any) {
    logger.error(error.message)
    Deno.exit(1)
  }
}

export async function runKbdgenDeploy() {
  const cargoToml = await loadCargoToml()
  const baseVersion = cargoToml.package.version
  const version = await versionAsNightly(baseVersion)
  const allSecrets = await builder.secrets()

  const secrets = {
    pahkatApiKey: allSecrets.get("pahkat/apiKey"),
    awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
    awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
  }

  const packageId = derivePackageId()
  const pahkatRepo = "https://pahkat.uit.no/main/"
  const channel = "nightly"

  // Download all platform artifacts - try both path separators
  try {
    await builder.downloadArtifacts("target/*/release/kbdgen", ".")
  } catch (e) {
    logger.debug("Failed to download Unix-style kbdgen artifacts:", e.message)
  }

  try {
    await builder.downloadArtifacts("target\\*/release\\kbdgen.exe", ".")
  } catch (e) {
    // Try forward slash version as fallback
    try {
      await builder.downloadArtifacts("target/*/release/kbdgen.exe", ".")
    } catch (e2) {
      logger.debug(
        "Failed to download Windows-style kbdgen.exe artifacts:",
        e2.message,
      )
    }
  }

  // Find all kbdgen binary files
  const kbdgenFiles: { path: string; platform: string }[] = []

  for await (
    const entry of fs.walk(".", { includeFiles: true, includeDirs: false })
  ) {
    if (entry.name === "kbdgen" || entry.name === "kbdgen.exe") {
      // Extract platform from path like target/x86_64-pc-windows-msvc/release/kbdgen.exe
      const normalizedPath = path.normalize(entry.path)
      const pathParts = normalizedPath.split(path.SEP)
      const targetIndex = pathParts.indexOf("target")

      if (targetIndex >= 0 && targetIndex + 1 < pathParts.length) {
        const rustTarget = pathParts[targetIndex + 1]
        let platform: string

        if (rustTarget.includes("windows")) {
          platform = "windows"
        } else if (
          rustTarget.includes("darwin") || rustTarget.includes("apple")
        ) {
          platform = "macos"
        } else if (rustTarget.includes("linux")) {
          platform = "linux"
        } else {
          logger.warn(`Unknown platform for target ${rustTarget}, skipping`)
          continue
        }

        kbdgenFiles.push({ path: entry.path, platform })
      }
    }
  }

  if (kbdgenFiles.length === 0) {
    throw new Error("No kbdgen binary files found for deployment")
  }

  console.log("Deploying kbdgen binaries:")
  for (const file of kbdgenFiles) {
    console.log(`- ${file.platform}: ${file.path}`)
  }

  // Deploy each platform binary
  for (const file of kbdgenFiles) {
    await kbdgenDeploy({
      payloadPath: file.path,
      platform: file.platform,
      version,
      channel,
      pahkatRepo,
      packageId,
      secrets,
    })
  }
}
