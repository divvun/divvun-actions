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
  const langTag = builder.env.repoName.split("lang-")[1]?.split("-")[0] || "unknown"

  logger.debug(
    `Grammar bundle for ${name} with version ${version} and langTag ${langTag}`,
  )

  const isGrammarReleaseTag = GRAMMAR_RELEASE_TAG.test(builder.env.tag ?? "")

  const packageId = `grammar-${langTag}`
  const txzPath = `${packageId}_${version}_bundle.txz`

  const allFiles = [...drbPaths, ...zcheckPaths]
  logger.debug(`Creating txz from [${allFiles.join(", ")}] at ${txzPath}`)

  await Tar.createFlatTxz(allFiles, txzPath)
  logger.debug(`Created txz at ${txzPath}`)

  await builder.uploadArtifacts(txzPath)
  await builder.setMetadata("grammar-version", version)
  await builder.setMetadata("grammar-name", name)

  return {
    payloadPath: txzPath,
  }
}
