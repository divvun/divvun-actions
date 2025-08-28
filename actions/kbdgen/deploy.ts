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
  Tar,
  versionAsNightly,
} from "~/util/shared.ts"

// Constants
const CONSTANTS = {
  PLATFORMS: {
    MACOS: "macos",
    LINUX: "linux",
    WINDOWS: "windows",
  },
  ARCHITECTURES: {
    X86_64: "x86_64",
    AARCH64: "aarch64",
  },
} as const

async function loadCargoToml(): Promise<any> {
  const cargoString = await Deno.readTextFile("./Cargo.toml")
  return nonUndefinedProxy(toml.parse(cargoString), true)
}

/**
 * Extracts architecture from a Rust target string
 */
function extractArchitecture(rustTarget: string): string {
  if (rustTarget.includes(CONSTANTS.ARCHITECTURES.X86_64)) {
    return CONSTANTS.ARCHITECTURES.X86_64
  } else if (rustTarget.includes(CONSTANTS.ARCHITECTURES.AARCH64)) {
    return CONSTANTS.ARCHITECTURES.AARCH64
  }
  return "unknown"
}

/**
 * Determines platform from Rust target string
 */
function determinePlatform(rustTarget: string): string | null {
  if (rustTarget.includes("windows")) {
    return CONSTANTS.PLATFORMS.WINDOWS
  } else if (rustTarget.includes("darwin") || rustTarget.includes("apple")) {
    return CONSTANTS.PLATFORMS.MACOS
  } else if (rustTarget.includes("linux")) {
    return CONSTANTS.PLATFORMS.LINUX
  }
  return null
}

/**
 * Creates dist/bin directory structure and copies binary
 */
async function createDistDirectory(payloadPath: string): Promise<string> {
  const distDir = path.join(path.dirname(payloadPath), "dist")
  const binDir = path.join(distDir, "bin")
  await Deno.mkdir(binDir, { recursive: true })

  const binaryName = path.basename(payloadPath)
  const distBinaryPath = path.join(binDir, binaryName)
  await Deno.copyFile(payloadPath, distBinaryPath)

  return distDir
}

function releaseReq(
  version: string,
  platform: string,
  channel: string | null,
  architecture: string,
): ReleaseRequest {
  const req: ReleaseRequest = {
    version,
    platform,
    arch: architecture,
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

    // Extract architecture from the payload path
    const rustTarget = path.basename(path.dirname(path.dirname(payloadPath)))
    const architecture = extractArchitecture(rustTarget)

    // Create dist/bin directory structure and copy binary
    const distDir = await createDistDirectory(payloadPath)

    const pathItems = [packageId, version, platform, architecture]
    const txzFileName = `${pathItems.join("_")}.txz`
    const txzPath = path.join(path.dirname(payloadPath), txzFileName)

    await Tar.createFlatTxz([distDir], txzPath)

    const artifactUrl = `${PahkatUploader.ARTIFACTS_URL}${
      path.basename(txzPath)
    }`
    const artifactSize = getArtifactSize(txzPath)

    const payloadMetadata = await PahkatUploader.release.tarballPackage(
      releaseReq(version, platform, channel, architecture),
      artifactUrl,
      1,
      artifactSize,
      secrets,
    )

    if (payloadMetadata == null) {
      throw new Error("Payload is null; this is a logic error.")
    }

    await Deno.writeTextFile("./metadata.toml", payloadMetadata)

    logger.info(`Created .txz package: ${txzPath}`)
    logger.info(`Generated metadata.toml:`)
    logger.info(payloadMetadata)
    logger.info(`Repository URL: ${repoPackageUrl}`)
    logger.info(`Artifact URL: ${artifactUrl}`)

    await PahkatUploader.upload(
      txzPath,
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

  const packageId = "kbdgen"
  const pahkatRepo = "https://pahkat.uit.no/devtools/"
  const channel = "nightly"

  await builder.downloadArtifacts("target/*/release/kbdgen", ".")
  await builder.downloadArtifacts("target\\*\\release\\kbdgen.exe", ".")
  try {
    await builder.downloadArtifacts("target/*/release/kbdgen.exe", ".")
  } catch (_e) {
    logger.info("Forward slash Windows pattern not needed (already downloaded)")
  }

  const kbdgenFiles: { path: string; platform: string }[] = []

  // Find Unix binaries (no extension)
  for await (const file of fs.expandGlob("target/*/release/kbdgen")) {
    if (file.isFile) {
      const rustTarget = path.basename(path.dirname(path.dirname(file.path)))
      const platform = determinePlatform(rustTarget)

      if (!platform) {
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
      const platform = determinePlatform(rustTarget)

      if (platform !== CONSTANTS.PLATFORMS.WINDOWS) {
        logger.warning(
          `Expected Windows platform but got ${platform} for target ${rustTarget}, skipping`,
        )
        continue
      }

      logger.info(`Found ${platform} binary: ${file.path}`)
      kbdgenFiles.push({ path: file.path, platform })
    }
  }

  if (kbdgenFiles.length === 0) {
    throw new Error("No kbdgen binary files found for deployment")
  }

  logger.info("Deploying kbdgen binaries:")
  for (const file of kbdgenFiles) {
    logger.info(`- ${file.platform}: ${file.path}`)
  }

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
