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
import { makeTempDir } from "~/util/temp.ts"

async function loadCargoToml(): Promise<any> {
  const cargoString = await Deno.readTextFile("./pahkat-client-core/Cargo.toml")
  return nonUndefinedProxy(toml.parse(cargoString), true)
}

async function createTarball(
  libPath: string,
  packageId: string,
  version: string,
): Promise<string> {
  using tempDir = await makeTempDir()

  const distLibPath = path.join(tempDir.path, "lib")
  await fs.copy(libPath, distLibPath, { overwrite: true })

  const pathItems = [packageId, version, "android"]
  const txzFileName = `${pathItems.join("_")}.txz`
  const txzPath = path.join(tempDir.path, txzFileName)

  await Tar.createFlatTxz([distLibPath], txzPath)

  return txzPath
}

function releaseReq(
  version: string,
  channel: string | null,
): ReleaseRequest {
  const req: ReleaseRequest = {
    version,
    platform: "android",
  }

  if (channel) {
    req.channel = channel
  }

  return req
}

export type Props = {
  libPath: string
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

export default async function pahkatClientDeploy({
  libPath,
  version,
  channel,
  pahkatRepo,
  packageId,
  secrets,
}: Props) {
  try {
    const repoPackageUrl = `${pahkatRepo}packages/${packageId}`

    const txzPath = await createTarball(
      libPath,
      packageId,
      version,
    )

    const artifactUrl = `${PahkatUploader.ARTIFACTS_URL}${
      path.basename(txzPath)
    }`
    const artifactSize = getArtifactSize(txzPath)

    const payloadMetadata = await PahkatUploader.release.tarballPackage(
      releaseReq(version, channel),
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

export async function runPahkatClientDeploy() {
  const cargoToml = await loadCargoToml()
  const baseVersion = cargoToml.package.version
  const version = await versionAsNightly(baseVersion)
  const allSecrets = await builder.secrets()

  const secrets = {
    pahkatApiKey: allSecrets.get("pahkat/apiKey"),
    awsAccessKeyId: allSecrets.get("s3/accessKeyId"),
    awsSecretAccessKey: allSecrets.get("s3/secretAccessKey"),
  }

  const packageId = "libpahkat_client"
  const pahkatRepo = "https://pahkat.uit.no/devtools/"
  const channel = "nightly"

  using artifactsDir = await makeTempDir()
  await builder.downloadArtifacts("lib/**/*", artifactsDir.path)
  const libPath = path.join(artifactsDir.path, "lib")

  try {
    const libStat = await Deno.stat(libPath)
    if (!libStat.isDirectory) {
      throw new Error("lib is not a directory")
    }
  } catch (_e) {
    throw new Error(
      "No lib directory found in artifacts - Android build may have failed",
    )
  }

  logger.info(`Found lib directory: ${libPath}`)

  // List contents for debugging
  for await (const file of fs.walk(libPath)) {
    if (file.isFile) {
      logger.info(`- ${file.path}`)
    }
  }

  await pahkatClientDeploy({
    libPath,
    version,
    channel,
    pahkatRepo,
    packageId,
    secrets,
  })
}

