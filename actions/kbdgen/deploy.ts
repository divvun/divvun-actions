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

  // Download all platform artifacts using simple patterns like lang deployment
  await builder.downloadArtifacts("target/*/release/kbdgen", ".")
  await builder.downloadArtifacts("target\\*\\release\\kbdgen.exe", ".")
  try {
    await builder.downloadArtifacts("target/*/release/kbdgen.exe", ".")
  } catch (e) {
    logger.info("Forward slash Windows pattern not needed (already downloaded)")
  }

  // Use fs.expandGlob to find all kbdgen files like lang deployment does
  const kbdgenFiles: { path: string; platform: string }[] = []

  // Find Unix binaries (no extension)
  for await (const file of fs.expandGlob("target/*/release/kbdgen")) {
    if (file.isFile) {
      const rustTarget = path.basename(path.dirname(path.dirname(file.path)))
      let platform: string

      if (rustTarget.includes("darwin") || rustTarget.includes("apple")) {
        platform = "macos"
      } else if (rustTarget.includes("linux")) {
        platform = "linux"
      } else {
        logger.warning(
          `Unknown Unix platform for target ${rustTarget}, skipping`,
        )
        continue
      }

      logger.info(`Found ${platform} binary: ${file.path}`)
      kbdgenFiles.push({ path: file.path, platform })
    }
  }

  // Find Windows binaries (.exe extension)
  for await (const file of fs.expandGlob("target/*/release/kbdgen.exe")) {
    if (file.isFile) {
      const rustTarget = path.basename(path.dirname(path.dirname(file.path)))

      if (rustTarget.includes("windows")) {
        logger.info(`Found windows binary: ${file.path}`)
        kbdgenFiles.push({ path: file.path, platform: "windows" })
      } else {
        logger.warning(
          `Unknown Windows platform for target ${rustTarget}, skipping`,
        )
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
