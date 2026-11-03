import * as fs from "@std/fs"
import * as builder from "~/builder.ts"
import { uploadCompressedArtifacts } from "~/util/compressed_artifact.ts"
import { globFiles } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { Tar } from "~/util/shared.ts"
import { Autotools } from "./build-speller.ts"
import { setupLangDependencies } from "./common.ts"

/** The analyser and generator .hfstol files, as one flat archive. */
export const ANALYSER_FST_BUNDLE = "analyser-fst-bundle.pkt.tar.zst"
/** The divvun-runtime analysis pipeline built from `tools/analysers/`. */
export const ANALYSER_DRB = "build/tools/analysers/bundle.drb"

const ANALYSER_FSTS = [
  "build/src/fst/analyser-*.hfstol",
  "build/src/fst/generator-*.hfstol",
]

/**
 * Analysers, generators and the analyser tool only: no spellers, so repos with
 * `spellers: false` build here too, in parallel with speller-build. The
 * analyser tool's `bundle.drb` needs the tokenisers, which default to off.
 */
const FLAGS = [
  "--without-forrest",
  "--disable-silent-rules",
  "--disable-spellers",
  "--disable-grammarchecker",
  "--disable-transcriptors",
  "--enable-analysers",
  "--enable-generators",
  "--enable-tokenisers",
  "--enable-analyser-tool",
]

export default async function langAnalyserBuild(): Promise<void> {
  logger.info("Building analysers, generators and the analyser bundle")

  await setupLangDependencies()

  logger.debug(`Flags: ${FLAGS}`)
  await new Autotools(Deno.cwd()).build(FLAGS)

  const fsts = (await Promise.all(ANALYSER_FSTS.map((glob) => globFiles(glob))))
    .flat()
  if (!fsts.some((file) => file.includes("/analyser-"))) {
    throw new Error("No analyser .hfstol files found in build/src/fst")
  }
  if (!await fs.exists(ANALYSER_DRB)) {
    throw new Error(`${ANALYSER_DRB} not found`)
  }

  logger.info(`Analyser FSTs: ${fsts.join(", ")}`)
  await Tar.createFlatPkt(fsts, ANALYSER_FST_BUNDLE)
  await builder.uploadArtifacts(ANALYSER_FST_BUNDLE)
  await uploadCompressedArtifacts(ANALYSER_DRB)
}
