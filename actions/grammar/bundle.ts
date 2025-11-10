import * as path from "@std/path"
import * as semver from "@std/semver"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { Tar } from "~/util/shared.ts"
import logger from "~/util/log.ts"

export type GrammarManifest = {
  name: string
  version: string
}

export type Props = {
  manifest: GrammarManifest
  drbPaths: string[]
  zcheckPaths: string[]
}

export type Output = {
  payloadPath: string
}

const GRAMMAR_RELEASE_TAG = /^grammar-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/

async function renameFile(filePath: string, newPath: string) {
  await Deno.rename(filePath, newPath)
  return newPath
}

export default async function grammarBundle({
  manifest,
  drbPaths,
  zcheckPaths,
}: Props): Promise<Output> {
  const { name, version } = manifest
  const langTag = builder.env.repoName.split("lang-")[1]?.split("-")[0] ||
    "unknown"

  logger.debug(
    `Grammar bundle for ${name} with version ${version} and langTag ${langTag}`,
  )

  const isGrammarReleaseTag = GRAMMAR_RELEASE_TAG.test(builder.env.tag ?? "")

  const packageId = `grammar-${langTag}`
  const pktPath = `${packageId}_${version}_bundle.pkt.tar.zst`

  const allFiles = [...drbPaths, ...zcheckPaths]
  logger.debug(`Creating pkt from [${allFiles.join(", ")}] at ${pktPath}`)

  await Tar.createFlatPkt(allFiles, pktPath)
  logger.debug(`Created pkt at ${pktPath}`)

  await builder.uploadArtifacts(pktPath)
  await builder.setMetadata("grammar-version", version)
  await builder.setMetadata("grammar-name", name)

  return {
    payloadPath: pktPath,
  }
}
