import * as path from "@std/path"

import logger from "~/util/log.ts"
import {
  getArtifactSize,
  MacOSPackageTarget,
  PahkatUploader,
  RebootSpec,
  ReleaseRequest,
  validateProductCode,
  WindowsExecutableKind,
} from "~/util/shared.ts"

export enum PackageType {
  MacOSPackage = "MacOSPackage",
  WindowsExecutable = "WindowsExecutable",
  TarballPackage = "TarballPackage",
}

export type Props =
  & {
    packageId: string
    // packageType: PackageType
    platform: string
    payloadPath: string
    arch?: string | null
    channel?: string | null
    dependencies?: { [key: string]: string } | null
    pahkatRepo: string
    version: string
    secrets: {
      awsAccessKeyId: string
      awsSecretAccessKey: string
      pahkatApiKey: string
    }
  }
  & (
    | {
      packageType: PackageType.MacOSPackage
      pkgId: string
      requiresReboot: RebootSpec[]
      targets: MacOSPackageTarget[]
    }
    | {
      packageType: PackageType.WindowsExecutable
      productCode: string
      kind: WindowsExecutableKind | null
      requiresReboot: RebootSpec[]
    }
    | {
      packageType: PackageType.TarballPackage
    }
  )

export default async function deploy({
  packageId,
  // packageType,
  platform,
  payloadPath,
  arch,
  channel,
  dependencies,
  pahkatRepo,
  version,
  secrets,
  ...props
}: Props) {
  const repoPackageUrl = `${pahkatRepo}/packages/${packageId}`

  logger.debug("Version: " + version)

  const ext = path.extname(payloadPath)
  const pathItems = [packageId, version, platform]

  if (arch != null) {
    pathItems.push(arch)
  }

  const artifactPath = path.join(
    path.dirname(payloadPath),
    `${pathItems.join("_")}${ext}`,
  )
  const artifactUrl = `${PahkatUploader.ARTIFACTS_URL}${
    path.basename(
      artifactPath,
    )
  }`
  const artifactSize = getArtifactSize(payloadPath)

  const releaseReq: ReleaseRequest = {
    platform,
    version,
  }

  if (channel) {
    releaseReq.channel = channel
  }

  if (arch) {
    releaseReq.arch = arch
  }

  if (dependencies) {
    releaseReq.dependencies = dependencies
  }

  if (props.packageType === PackageType.MacOSPackage) {
    const { pkgId, requiresReboot, targets } = props

    const data = await PahkatUploader.release.macosPackage(
      releaseReq,
      artifactUrl,
      1,
      artifactSize,
      pkgId,
      requiresReboot,
      targets,
      secrets,
    )
    await Deno.writeTextFile("./metadata.toml", data)
  } else if (props.packageType === PackageType.WindowsExecutable) {
    const { productCode: rawProductCode, kind, requiresReboot } = props

    let productCode

    switch (kind) {
      case WindowsExecutableKind.Inno:
      case WindowsExecutableKind.Nsis:
      case WindowsExecutableKind.Msi:
        productCode = validateProductCode(kind, rawProductCode)
        break
      case null:
        logger.debug("No Windows kind provided, not validating product code.")
        productCode = rawProductCode
        break
      default:
        throw new Error("Unhandled Windows executable kind: " + kind)
    }

    const data = await PahkatUploader.release.windowsExecutable(
      releaseReq,
      artifactUrl,
      1,
      artifactSize,
      kind,
      productCode,
      requiresReboot,
      secrets,
    )
    await Deno.writeTextFile("./metadata.toml", data)
  } else if (props.packageType === PackageType.TarballPackage) {
    const data = await PahkatUploader.release.tarballPackage(
      releaseReq,
      artifactUrl,
      1,
      artifactSize,
      secrets,
    )
    await Deno.writeTextFile("./metadata.toml", data)
  } else {
    // deno-lint-ignore no-explicit-any
    throw new Error(`Unhandled package type: '${(props as any).packageType}'`)
  }

  logger.debug(`Renaming from ${payloadPath} to ${artifactPath}`)
  await Deno.rename(payloadPath, artifactPath)

  await PahkatUploader.upload(
    artifactPath,
    artifactUrl,
    "./metadata.toml",
    repoPackageUrl,
    secrets,
  )
}
