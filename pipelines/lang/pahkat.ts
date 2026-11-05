// A lang-* build's Pahkat packages, main/speller-<lang> and
// main/proofing-<tag>, published to the Pahkat server beside the build's
// GitHub releases.

import * as toml from "@std/toml"
import { proofingLocales, proofingPackage } from "~/actions/proofing/source.ts"
import {
  deriveLangTag,
  type SpellerManifest,
} from "~/actions/speller/manifest.ts"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import {
  type ArtifactSource,
  downloadArtifacts,
  oneVersion,
  publishRelease,
  repositoryLicense,
} from "~/util/pahkat.ts"
import { makeTempDir } from "~/util/temp.ts"
import { pahkatSkipReasonForBuild, readProofingSource } from "./mod.ts"

/**
 * Whom a GiellaLT release names as its authors, which its sources do not
 * say: the two groups every speller's description names.
 */
const GIELLALT_AUTHORS = ["Divvun", "Giellatekno"]

/**
 * Which of the build's Buildkite artifacts make up a speller release, and
 * what each is. The outto ids are the ones the bundle steps build with.
 */
function spellerArtifacts(langTag: string): ArtifactSource[] {
  const outtoId = `no.divvun.speller.${langTag}`
  return [
    {
      pattern: "speller-*_noarch-windows.exe",
      kind: "outto-windows",
      outtoId,
    },
    {
      pattern: "speller-*_noarch-macos.app.zip",
      kind: "outto-macos",
      outtoId,
    },
    {
      pattern: "speller-*_noarch-mobile.pkt.box",
      kind: "box",
      os: ["ios", "android"],
    },
  ]
}

/** Likewise for a proofing release. */
function proofingArtifacts(langTag: string): ArtifactSource[] {
  const outtoId = `no.divvun.proofing.${langTag}`
  return [
    {
      pattern: "proofing-*_noarch-windows.exe",
      kind: "outto-windows",
      outtoId,
    },
    {
      pattern: "proofing-*_noarch-macos.app.zip",
      kind: "outto-macos",
      outtoId,
    },
    {
      pattern: "proofing-*_noarch-linux.pkt.box",
      kind: "box",
      os: ["linux"],
    },
  ]
}

async function readManifest(): Promise<SpellerManifest> {
  return toml.parse(
    await Deno.readTextFile("manifest.toml"),
  ) as unknown as SpellerManifest
}

/** Why this build publishes nothing to Pahkat, or null if it does. */
async function skipReason(): Promise<string | null> {
  return await pahkatSkipReasonForBuild(new GitHub(builder.env.repo))
}

/**
 * Publish the speller release a speller tag or main build made, as
 * main/speller-<lang>, `<lang>` what the repository's name has after
 * `lang-`. Its version is the one its artifacts carry.
 */
export async function runSpellerPahkatPublish() {
  const skip = await skipReason()
  if (skip) {
    logger.info(`Not publishing the speller to Pahkat: ${skip}`)
    return
  }

  const lang = builder.env.repoName.match(/^lang-(.+)$/)?.[1]
  if (!lang) {
    throw new Error(`${builder.env.repoName} is not named lang-<lang>`)
  }
  const id = `speller-${lang}`
  const langTag = deriveLangTag()
  const manifest = await readManifest()

  using dir = await makeTempDir({ prefix: "pahkat-speller-" })
  const artifacts = await downloadArtifacts(spellerArtifacts(langTag), dir.path)

  await publishRelease({
    package: id,
    version: oneVersion(artifacts, id),
    tag: builder.env.tag || `${id}/dev-latest`,
    metadata: {
      names: manifest.speller.name,
      descriptions: manifest.speller.description,
      authors: GIELLALT_AUTHORS,
      ...await repositoryLicense(),
      languages: [langTag],
      tags: ["cat:spellers"],
    },
    artifacts,
  })
}

/**
 * Publish the proofing release a proofing tag or main build made, as
 * main/proofing-<tag>, `<tag>` the language's tag. Its version is the one
 * its artifacts carry.
 */
export async function runProofingPahkatPublish() {
  const skip = await skipReason()
  if (skip) {
    logger.info(`Not publishing proofing to Pahkat: ${skip}`)
    return
  }

  const langTag = deriveLangTag()
  const id = `proofing-${langTag}`
  const manifest = await readManifest()
  const info = proofingPackage(await readProofingSource(), manifest)

  using dir = await makeTempDir({ prefix: "pahkat-proofing-" })
  const artifacts = await downloadArtifacts(
    proofingArtifacts(langTag),
    dir.path,
  )

  await publishRelease({
    package: id,
    version: oneVersion(artifacts, id),
    tag: builder.env.tag || `x-proofing-${langTag}/dev-latest`,
    metadata: {
      names: { en: `${info.name} (proofing)` },
      authors: GIELLALT_AUTHORS,
      ...await repositoryLicense(),
      languages: [...new Set([langTag, ...proofingLocales(manifest)])],
      tags: ["cat:proofing"],
    },
    artifacts,
  })
}
