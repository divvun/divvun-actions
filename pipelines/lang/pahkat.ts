// A lang-* build's Pahkat package, main/proofing-<tag>, published to the
// Pahkat server beside the build's GitHub releases. Spellers are not
// Pahkat-3 packages: proofing does their work, spelling always and grammar
// where the language has it.

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
 * say: the two groups every language's description names.
 */
const GIELLALT_AUTHORS = ["Divvun", "Giellatekno"]

/**
 * Which of the proofing build's Pahkat artifacts make up its release, and
 * what each is. The outto ids are the ones the bundle steps build with.
 */
function proofingArtifacts(langTag: string): ArtifactSource[] {
  const outtoId = `no.divvun.proofing.${langTag}`
  return [
    {
      name: "*_noarch-windows*.exe",
      kind: "outto-windows",
      outtoId,
    },
    {
      name: "*_noarch-macos.app.zip",
      kind: "outto-macos",
      outtoId,
    },
    {
      name: "*_noarch-linux.pkt.box",
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
    id,
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
