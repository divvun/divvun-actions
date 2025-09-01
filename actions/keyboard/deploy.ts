// deno-lint-ignore-file no-explicit-any
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

import {
  getArtifactSize,
  Kbdgen,
  MacOSPackageTarget,
  PahkatUploader,
  RebootSpec,
  ReleaseRequest,
  validateProductCode,
  WindowsExecutableKind,
} from "~/util/shared.ts"

import { KeyboardType } from "./types.ts"

type ArtifactInfo = {
  path: string
  url: string
  size: number
}

type PlatformMetadata = {
  platform: string
  payloadMetadata: string
}

export type Props = {
  payloadPath: string
  keyboardType: KeyboardType
  bundlePath: string
  channel: string | null
  pahkatRepo: string
  packageId: string
  version: string
  secrets: {
    pahkatApiKey: string
    awsAccessKeyId: string
    awsSecretAccessKey: string
  }
}

export function derivePackageId() {
  const repo = builder.env.repo
  if (!repo.startsWith("keyboard-")) {
    throw new Error("Repository is not prefixed with 'keyboard")
  }

  const lang = builder.env.repo.split("keyboard-")[1]
  return `keyboard-${lang}`
}

export default async function keyboardDeploy({
  payloadPath,
  keyboardType,
  bundlePath,
  channel,
  pahkatRepo,
  packageId,
  version,
  secrets,
}: Props) {
  const repoPackageUrl = `${pahkatRepo}packages/${packageId}`
  const artifactInfo = createArtifactInfo(payloadPath)

  const metadata = keyboardType === KeyboardType.MacOS
    ? await createMacOSMetadata(
      bundlePath,
      version,
      channel,
      artifactInfo,
      secrets,
    )
    : keyboardType === KeyboardType.Windows
    ? await createWindowsMetadata(
      bundlePath,
      version,
      channel,
      artifactInfo,
      secrets,
    )
    : (() => {
      throw new Error("Unhandled keyboard type: " + keyboardType)
    })()

  await Deno.writeTextFile("./metadata.toml", metadata.payloadMetadata)
  const metadataJsonPath = await writeMetadataJson(bundlePath)

  logger.debug(`Using artifact path: ${artifactInfo.path}`)

  await PahkatUploader.upload(
    artifactInfo.path,
    artifactInfo.url,
    "./metadata.toml",
    repoPackageUrl,
    secrets,
    {
      metadataJsonPath,
    },
  )
}

function createArtifactInfo(payloadPath: string): ArtifactInfo {
  return {
    path: payloadPath,
    url: `${PahkatUploader.ARTIFACTS_URL}${path.basename(payloadPath)}`,
    size: getArtifactSize(payloadPath),
  }
}

async function createMacOSMetadata(
  bundlePath: string,
  version: string,
  channel: string | null,
  artifactInfo: ArtifactInfo,
  secrets: Props["secrets"],
): Promise<PlatformMetadata> {
  const target = await Kbdgen.loadTarget(bundlePath, "macos")
  let pkgId = target.packageId
  const lang = builder.env.repo.split("keyboard-")[1]

  // On macos kbdgen does magic with the keyboard id to match this:
  // `no.giella.keyboard.%lang%.keyboardLayout.%lang%` because macos.
  // Since kbdgen currently relies on the packageId to not contain the
  // `keyboardLayout.%lang%` part (it adds it itself), we have to "fix"
  // the published ID here.
  pkgId = `${pkgId}.keyboardlayout.${lang}`

  const platform = "macos"
  const payloadMetadata = await PahkatUploader.release.macosPackage(
    releaseReq(version, platform, channel),
    artifactInfo.url,
    1,
    artifactInfo.size,
    pkgId,
    [RebootSpec.Install, RebootSpec.Uninstall],
    [MacOSPackageTarget.System, MacOSPackageTarget.User],
    secrets,
  )

  return { platform, payloadMetadata }
}

async function createWindowsMetadata(
  bundlePath: string,
  version: string,
  channel: string | null,
  artifactInfo: ArtifactInfo,
  secrets: Props["secrets"],
): Promise<PlatformMetadata> {
  const target = await Kbdgen.loadTarget(bundlePath, "windows")
  const productCode = validateProductCode(
    WindowsExecutableKind.Inno,
    target.uuid,
  )

  const platform = "windows"
  const payloadMetadata = await PahkatUploader.release.windowsExecutable(
    releaseReq(version, platform, channel),
    artifactInfo.url,
    1,
    artifactInfo.size,
    WindowsExecutableKind.Inno,
    productCode,
    [RebootSpec.Install, RebootSpec.Uninstall],
    secrets,
  )

  return { platform, payloadMetadata }
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

  logger.info("releaseReq", version, channel)
  if (channel) {
    req.channel = channel
  } else {
    if (version.startsWith("0")) {
      logger.info("channel: beta")
      req.channel = "beta"
    } else {
      logger.info("channel: stable")
      // Empty channel means stable
      req.channel = ""
    }
  }

  return req
}

async function writeMetadataJson(bundlePath: string): Promise<string | null> {
  const project: any = await Kbdgen.loadProjectBundleWithoutProxy(bundlePath)
  const locales = project.locales
  if (!locales) {
    return null
  }
  const localesJson = JSON.stringify(locales)
  const metadataJsonPath = "./metadata.json"
  await Deno.writeTextFile(metadataJsonPath, localesJson)
  return metadataJsonPath
}
