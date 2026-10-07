// Builds, signs and publishes the Divvun keyboard text service installer from
// the kbdgen repository. It is released separately from keyboards and kbdgen
// (kbdgen spec tsf.component); keyboard installers embed the published
// installer (tsf.installer.bundle, actions/keyboard/build/tip.ts).

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import {
  buildTipDlls,
  compileTipInstaller,
  readTipVersion,
  setTipVersion,
  signTipDlls,
  TIP_DEV_TAG,
  TIP_NAME,
  TIP_TARGET,
} from "~/actions/kbd-tsf/installer.ts"
import type { CommandStep } from "~/builder/pipeline.ts"
import { isKbdgenV4Build } from "~/actions/kbdgen/v4.ts"
import { assetFileName } from "~/util/asset_name.ts"
import { downloadBinary } from "~/util/artifact_download.ts"
import { GitHub } from "~/util/github.ts"
import { blake3Hash, createSignedChecksums } from "~/util/hash.ts"
import { versionAsDev } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

/** A release tag, `kbd-tsf-v<kbd-tsf version>`. */
const TIP_RELEASE_TAG =
  /^kbd-tsf-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

/** The artifacts passed from the Windows build to the publish step. */
const INSTALLER = `${TIP_NAME}.exe`
const RECORD = `${TIP_NAME}.json`
export const TIP_BUILD_KEY = "kbd-tsf-installer"

type TipRecord = {
  version: string
  commit: string
  signed: boolean
  blake3: string
}

/**
 * Release for a `kbd-tsf-v*` tag, dev for main, v4 for kbdgen's v4 branch
 * (published with kbdgen by runKbdgenPublishV4), otherwise nothing published.
 */
export function tipReleaseMode(): "release" | "dev" | "v4" | null {
  if (builder.env.pullRequest && builder.env.pullRequest !== "false") {
    return null
  }
  if (builder.env.tag) {
    return TIP_RELEASE_TAG.test(builder.env.tag) ? "release" : null
  }
  if (isKbdgenV4Build()) {
    return "v4"
  }
  return builder.env.branch === "main" ? "dev" : null
}

/**
 * The steps that turn `kbdgenStep`'s x64 Windows kbdgen into a text service
 * installer, and publish it from main and from release tags. On the v4
 * branch, the kbdgen v4 publish step publishes it instead.
 */
export function tipSteps(
  kbdgenStep: string,
  command: (input: CommandStep) => CommandStep,
): CommandStep[] {
  const mode = tipReleaseMode()
  const steps = [command({
    key: TIP_BUILD_KEY,
    label: `Text service installer${mode ? " (signed)" : " (unsigned)"}`,
    agents: { queue: "windows" },
    depends_on: kbdgenStep,
    command: "divvun-actions run kbd-tsf-installer",
    plugins: [{
      "cache#v1.7.0": {
        manifest: "Cargo.lock",
        path: "target",
        restore: "file",
        save: "file",
        "key-extra": "kbd-tsf",
      },
    }],
  })]
  if (mode === "release" || mode === "dev") {
    steps.push(command({
      label: `Publish text service (${
        mode === "release" ? "release" : TIP_DEV_TAG
      })`,
      agents: { queue: "linux" },
      depends_on: TIP_BUILD_KEY,
      command: "divvun-actions run kbd-tsf-publish",
      concurrency: 1,
      concurrency_group: "kbdgen/kbd-tsf-releases",
    }))
  }
  return steps
}

async function tipVersion(): Promise<string> {
  const base = await readTipVersion(".")
  if (tipReleaseMode() === "release") {
    const tagged = TIP_RELEASE_TAG.exec(builder.env.tag!)![1]
    if (tagged !== base) {
      throw new Error(`Tag version ${tagged} is not kbd-tsf's ${base}`)
    }
    return tagged
  }
  return versionAsDev(base, builder.env.buildTimestamp, undefined)
}

/**
 * On a Windows agent: builds the text service DLLs with the kbdgen of the
 * same commit, signs them and the installer when the build is published, and
 * uploads the installer with a record of what it is.
 */
export async function runTipInstaller() {
  const signed = tipReleaseMode() !== null
  const version = await tipVersion()
  await setTipVersion(".", version)

  using work = await makeTempDir({ prefix: "kbd-tsf-" })
  const kbdgenPath = "target/x86_64-pc-windows-msvc/release/kbdgen.exe"
  await downloadBinary(kbdgenPath, work.path)
  const kbdgen = path.join(work.path, kbdgenPath)

  const payloadDir = path.join(work.path, "dlls")
  const dlls = await buildTipDlls(kbdgen, path.resolve("."), payloadDir)
  if (signed) {
    await signTipDlls(dlls)
  }

  const installer = await compileTipInstaller({
    version,
    payloadDir,
    outputDir: path.resolve("."),
    baseName: TIP_NAME,
    sign: signed,
  })
  const record: TipRecord = {
    version,
    commit: builder.env.commit ?? "",
    signed,
    blake3: await blake3Hash(installer),
  }
  await Deno.writeTextFile(RECORD, JSON.stringify(record, null, 2))
  await builder.uploadArtifacts(INSTALLER)
  await builder.uploadArtifacts(RECORD)
}

/**
 * Downloads this commit's signed installer into `directory`, checked against
 * its build record, as `divvun-tip_windows_<version>.exe`, and returns that
 * name and version.
 */
export async function downloadTipAsset(
  directory: string,
): Promise<{ name: string; version: string }> {
  await builder.downloadArtifacts(INSTALLER, directory)
  await builder.downloadArtifacts(RECORD, directory)
  const record: TipRecord = JSON.parse(
    await Deno.readTextFile(path.join(directory, RECORD)),
  )
  const installer = path.join(directory, INSTALLER)
  if (!record.signed || record.commit !== builder.env.commit) {
    throw new Error("The installer is not this commit's signed build")
  }
  if (await blake3Hash(installer) !== record.blake3) {
    throw new Error("The installer does not match its build record")
  }
  const name = assetFileName(TIP_NAME, TIP_TARGET, record.version, "exe")
  await Deno.rename(installer, path.join(directory, name))
  return { name, version: record.version }
}

/**
 * Publishes the signed installer as `divvun-tip_windows_<version>.exe` with a
 * minisigned BLAKE3SUMS, to the `kbd-tsf-v*` release or to the rolling
 * TIP_DEV_TAG prerelease.
 */
export async function runTipPublish() {
  const mode = tipReleaseMode()
  if ((mode !== "release" && mode !== "dev") || !builder.env.repo) {
    throw new Error(
      "Publishing the text service needs main or a kbd-tsf-v* tag, outside a pull request",
    )
  }
  using artifacts = await makeTempDir({ prefix: "kbd-tsf-publish-" })
  const { name, version } = await downloadTipAsset(artifacts.path)
  const { checksumFile, signatureFile } = await createSignedChecksums(
    [name],
    await builder.secrets(),
    artifacts.path,
  )
  const files = [path.join(artifacts.path, name), checksumFile, signatureFile]
  const gh = new GitHub(builder.env.repo)
  if (mode === "release") {
    await gh.createRelease(builder.env.tag!, files, {
      latest: false,
      name: `Divvun Text Service ${version}`,
    })
  } else {
    await gh.updateRelease(TIP_DEV_TAG, files, {
      draft: false,
      prerelease: true,
      name: `Divvun Text Service ${version}`,
    })
  }
}
