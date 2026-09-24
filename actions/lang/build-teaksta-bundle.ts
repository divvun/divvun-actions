import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { globFiles } from "~/util/glob.ts"
import logger from "~/util/log.ts"
import { BuildProps } from "../../pipelines/lang/mod.ts"
import {
  downloadAndRestoreDependencySnapshot,
  setupLangToolchain,
} from "./common.ts"

/**
 * Build the teaksta (Konteaksta) divvun-runtime bundle for a language.
 *
 * The recipe is not this action's to own: it lives in the language repo, at
 * `tools/teaksta/{pipeline.ts, assemble-assets.sh}`. This action's job is to
 * put the inputs that script expects in place on a CI agent and then run it.
 *
 * What the script needs, and where each piece comes from:
 *
 * - `ZCHECK_DIR` — the tokeniser (`tokeniser-gramcheck-gt-desc.pmhfst`), the
 *   whitespace analyser (`analyser-gt-whitespace.hfst`) and the MWE
 *   disambiguator (`mwe-dis.bin`). Locally the script reads these out of an
 *   unpacked grammar-checker bundle, because building the pmhfst needs the
 *   full hfst toolchain. On CI the grammar-build step has already produced
 *   exactly that bundle and uploaded it (`build/tools/grammarcheckers/*.zcheck`
 *   — a flat zip), so this action downloads it and unpacks it rather than
 *   repeating a whole giella build. That is why the pipeline step depends on
 *   `grammar-build`.
 * - `$LANG_SME/src/cg3` and `$SHARED_SMI/src/cg3` — the CG grammar sources the
 *   script flattens (CG-3 `INCLUDE` is textual inclusion, and the runtime
 *   resolves it against the loader's cwd, which inside a .drb is not the asset
 *   store). The language's own sources are in the checkout; the shared
 *   sibling comes from speller-build's dependency snapshot, since
 *   configure.ac declares it via `gt_USE_SHARED`.
 *
 * With `assets/` assembled, `divvun-runtime bundle` packages it against
 * `pipeline.ts` into `bundle.drb`.
 *
 * NOTE ON THE divvun-runtime PIN: the agent image installs divvun-runtime at
 * the version pinned in docker/versions.ts (`divvunRuntime`). The pin at time
 * of writing is 0.3.1, which does carry everything `tools/teaksta/pipeline.ts`
 * uses — `bundle -a/-p`, the `.divvun-rt` binding sync, and the `hfst.tokenize`
 * / `divvun.blanktag` / `cg3.vislcg3` / `cg3.mwesplit` / `cg3.sentences`
 * modules. If a future pipeline.ts reaches for something newer, this step is
 * where it will fail, and the fix is to bump `versions.divvunRuntime` and
 * rebuild the images — not to work around it here.
 */

const TEAKSTA_DIR = "tools/teaksta"
const ASSEMBLE_SCRIPT = "assemble-assets.sh"
const BUNDLE_FILE = "bundle.drb"

/** The three model files the assemble script copies out of `ZCHECK_DIR`. */
const REQUIRED_ZCHECK_FILES = [
  "tokeniser-gramcheck-gt-desc.pmhfst",
  "analyser-gt-whitespace.hfst",
  "mwe-dis.bin",
]

export type Output = {
  teakstaBundlePath: string
}

async function run(cmd: string, args: string[], options?: {
  cwd?: string
  env?: Record<string, string>
}) {
  logger.info(`$ ${cmd} ${args.join(" ")}`)
  await builder.exec(cmd, args, options)
}

/**
 * Download the grammar-build step's `.zcheck` and unpack it. Buildkite stores
 * an artifact under its path relative to the upload cwd, so the download lands
 * back at `build/tools/grammarcheckers/`, same as the grammar bundle and
 * deploy actions expect.
 */
async function unpackZcheck(): Promise<string> {
  await builder.downloadArtifacts("*.zcheck", ".")

  const zchecks = await globFiles("build/tools/grammarcheckers/*.zcheck")
  if (zchecks.length === 0) {
    throw new Error(
      "No .zcheck found; the teaksta bundle build needs the grammar-build " +
        "step's output for the tokeniser, whitespace analyser and mwe-dis",
    )
  }
  if (zchecks.length > 1) {
    throw new Error(
      `Expected exactly one .zcheck, found ${zchecks.length}: ${
        zchecks.join(", ")
      }`,
    )
  }

  const zcheckDir = path.join(Deno.cwd(), "build", "teaksta-zcheck")
  await fs.ensureDir(zcheckDir)
  // A .zcheck is a flat zip; bsdtar (libarchive-tools, in the agent image)
  // reads it without a separate unzip step.
  await run("bsdtar", ["-xf", zchecks[0], "-C", zcheckDir])

  for (const file of REQUIRED_ZCHECK_FILES) {
    if (!(await fs.exists(path.join(zcheckDir, file)))) {
      throw new Error(`${file} not found in ${zchecks[0]}`)
    }
  }

  return zcheckDir
}

export default async function langTeakstaBundleBuild(
  buildConfig: BuildProps,
): Promise<Output> {
  logger.info("Building teaksta bundle")
  logger.info(JSON.stringify(buildConfig, null, 2))

  const assembleScript = path.join(TEAKSTA_DIR, ASSEMBLE_SCRIPT)
  if (!(await fs.exists(assembleScript))) {
    throw new Error(
      `${assembleScript} not found; this repo has no teaksta bundle recipe ` +
        `(is build["teaksta-bundle"] set in .build-config.yml by mistake?)`,
    )
  }

  // The shared-* siblings declared in configure.ac, as speller-build used
  // them: where the shared CG grammars the assemble script flattens live.
  await setupLangToolchain()
  await downloadAndRestoreDependencySnapshot()

  const zcheckDir = await unpackZcheck()

  // speller-build clones declared siblings best-effort, so one it couldn't
  // clone is missing from the snapshot too — say so plainly rather than
  // letting the assemble script fail later with "unresolved INCLUDEs remain".
  const sharedSmi = path.resolve(Deno.cwd(), "..", "shared-smi")
  if (!(await fs.exists(sharedSmi))) {
    throw new Error(
      `${sharedSmi} is not checked out; the teaksta bundle's CG grammars ` +
        `INCLUDE files from it. It comes from the speller-build step's ` +
        `dependency snapshot, so check that step's log for why it was not ` +
        `cloned.`,
    )
  }

  logger.info(`Assembling teaksta assets (ZCHECK_DIR=${zcheckDir})`)
  await run("bash", [ASSEMBLE_SCRIPT], {
    cwd: TEAKSTA_DIR,
    env: {
      ZCHECK_DIR: zcheckDir,
      SHARED_SMI: sharedSmi,
    },
  })

  // `divvun-runtime bundle` writes ./bundle.drb relative to its cwd, and
  // resolves the asset/pipeline paths from there too.
  logger.info("Bundling with divvun-runtime")
  await run("divvun-runtime", [
    "bundle",
    "-a",
    "assets",
    "-p",
    "pipeline.ts",
  ], { cwd: TEAKSTA_DIR })

  const bundlePath = path.join(TEAKSTA_DIR, BUNDLE_FILE)
  if (!(await fs.exists(bundlePath))) {
    throw new Error(`teaksta ${BUNDLE_FILE} not found at ${bundlePath}!`)
  }

  await builder.uploadArtifacts(bundlePath)

  logger.info(`teaksta bundle: ${bundlePath}`)

  await builder.setMetadata(
    "teaksta-bundle-paths",
    JSON.stringify([bundlePath]),
  )

  return {
    teakstaBundlePath: bundlePath,
  }
}
