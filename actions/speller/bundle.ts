import * as path from "@std/path"

import * as builder from "~/builder.ts"
import {
  Ditto,
  SpellerPaths,
  Tar,
  ThfstTools,
  versionAsNightly,
} from "~/util/shared.ts"
import { buildSpellerOutto } from "./bundle-outto.ts"
import logger from "~/util/log.ts"
import {
  deriveLangTag,
  derivePackageId,
  SpellerManifest,
  SpellerType,
} from "./manifest.ts"

export type Props = {
  spellerType: SpellerType
  manifest: SpellerManifest
  spellerPaths: SpellerPaths
}

export type Output = {
  payloadPath: string
}

const RELEASE_TAG = /^speller-(.*?)\/v\d+\.\d+\.\d+(-\S+)?/

export default async function spellerBundle({
  spellerType,
  manifest,
  spellerPaths,
}: Props): Promise<Output> {
  const spellerName = manifest.package.speller.name
  const packageId = derivePackageId(spellerType)
  const langTag = deriveLangTag()

  let payloadPath: string

  // TODO: allow release builds
  const isSpellerReleaseTag = RELEASE_TAG.test(builder.env.tag ?? "")
  const version = isSpellerReleaseTag
    ? manifest.package.speller.version
    : await versionAsNightly(
      manifest.package.speller.version,
      builder.env.buildNumber,
    )
  logger.debug(
    `Speller bundle for ${spellerType} with version ${version} and langTag ${langTag}`,
  )

  if (spellerType == SpellerType.Mobile) {
    const bhfstPaths = []

    for (const [langTag, zhfstPath] of Object.entries(spellerPaths.mobile)) {
      const bhfstPath = await ThfstTools.zhfstToBhfst(zhfstPath)
      const langTagBhfst = `${path.dirname(bhfstPath)}/${langTag}.bhfst`

      logger.debug(`Copying ${bhfstPath} to ${langTagBhfst}`)
      await Deno.copyFile(bhfstPath, langTagBhfst)
      bhfstPaths.push(langTagBhfst)
    }

    const pktPath = `${packageId}_${version}_noarch-mobile.pkt.tar.zst`
    logger.debug(
      `Creating pkt from [${bhfstPaths.join(", ")}] at ${pktPath}`,
    )
    payloadPath = pktPath
    await Tar.createFlatPkt(bhfstPaths, payloadPath)
    logger.debug(`Created pkt at ${payloadPath}`)
  } else if (
    spellerType == SpellerType.Windows || spellerType == SpellerType.MacOS
  ) {
    const result = await buildSpellerOutto({
      spellerType,
      packageId,
      langTag,
      version,
      buildNumber: parseInt(builder.env.buildNumber ?? "1"),
      spellerName,
      manifest,
      spellerPaths,
    })
    payloadPath = result.payloadPath
    logger.debug(`Outto installer created at ${payloadPath}`)
  } else {
    throw new Error(`Unsupported speller type: ${spellerType}`)
  }

  // outto on macOS produces a .app *directory*. Buildkite artifact upload
  // assumes a file path, so we ditto-zip the .app first (preserves resource
  // forks, xattrs, codesign signatures). The other payloads are single files.
  let uploadPath = payloadPath
  if (spellerType === SpellerType.MacOS) {
    uploadPath = `${payloadPath}.zip`
    await Ditto.zipApp(payloadPath, uploadPath)
    logger.debug(`Zipped .app for upload: ${uploadPath}`)
  }

  await builder.uploadArtifacts(uploadPath)
  await builder.setMetadata("speller-version", version)
  await builder.setMetadata("speller-type", spellerType)

  return {
    payloadPath: uploadPath,
  }
}
