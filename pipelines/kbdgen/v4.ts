import * as fs from "@std/fs"
import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import {
  isKbdgenV4Build,
  KBDGEN_NAME,
  KBDGEN_V4_TAG,
  KBDGEN_WINDOWS_TARGET,
} from "~/actions/kbdgen/v4.ts"
import { hasTextService } from "~/actions/kbd-tsf/installer.ts"
import type { CommandStep } from "~/builder/pipeline.ts"
import { assetFileName, assetStem } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import logger from "~/util/log.ts"
import { versionAsDev } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import { downloadTipAsset } from "./tip.ts"

/** Publishes every kbdgen build step's binary and the text service to KBDGEN_V4_TAG. */
export function v4PublishStep(
  dependsOn: string[],
  command: (input: CommandStep) => CommandStep,
): CommandStep {
  return command({
    label: `Publish kbdgen v4 (${KBDGEN_V4_TAG})`,
    command: "divvun-actions run kbdgen-publish-v4",
    depends_on: dependsOn,
    agents: { queue: "linux" },
    concurrency: 1,
    concurrency_group: `kbdgen/${KBDGEN_V4_TAG}`,
  })
}

/**
 * The kbdgen binaries the build steps uploaded, by Rust target. Windows
 * agents may store `target\<triple>\release\kbdgen.exe` with backslashes,
 * which a Linux download can keep in the file name, so the target is read
 * from the path split on either separator.
 */
async function downloadKbdgenBinaries(
  directory: string,
): Promise<Map<string, string>> {
  for (
    const pattern of [
      "target/*/release/kbdgen",
      "target/*/release/kbdgen.exe",
      "target\\*\\release\\kbdgen.exe",
    ]
  ) {
    try {
      await builder.downloadArtifacts(pattern, directory)
    } catch {
      logger.info(`No kbdgen artifacts match ${pattern}`)
    }
  }
  const binaries = new Map<string, string>()
  for await (const entry of fs.walk(directory, { includeDirs: false })) {
    const parts = path.relative(directory, entry.path).split(/[\\/]/)
    const [root, triple, release, name] = parts
    if (
      parts.length === 4 && root === "target" && release === "release" &&
      (name === "kbdgen" || name === "kbdgen.exe")
    ) {
      binaries.set(triple, entry.path)
    }
  }
  return binaries
}

/**
 * Replaces KBDGEN_V4_TAG's assets with this build's kbdgen for every target,
 * as `kbdgen_<target>_<version>[.exe]`, and its signed text service installer,
 * `divvun-tip_windows_<version>.exe`, with a minisigned BLAKE3SUMS of all of
 * them.
 */
export async function runKbdgenPublishV4() {
  if (!isKbdgenV4Build() || !builder.env.repo) {
    throw new Error("Publishing kbdgen v4 needs a push to the v4 branch")
  }
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    package?: { version?: string }
  }
  const version = versionAsDev(
    cargo.package?.version,
    builder.env.buildTimestamp,
    undefined,
  )

  using work = await makeTempDir({ prefix: "kbdgen-v4-" })
  const downloads = path.join(work.path, "artifacts")
  const assets = path.join(work.path, "assets")
  await Deno.mkdir(downloads)
  await Deno.mkdir(assets)

  const binaries = await downloadKbdgenBinaries(downloads)
  if (!binaries.has(KBDGEN_WINDOWS_TARGET)) {
    throw new Error(
      `No kbdgen for ${KBDGEN_WINDOWS_TARGET}, which keyboard builds need`,
    )
  }
  const names: string[] = []
  for (const [triple, binary] of binaries) {
    const name = binary.endsWith(".exe")
      ? assetFileName(KBDGEN_NAME, triple, version, "exe")
      : assetStem(KBDGEN_NAME, triple, version)
    await Deno.copyFile(binary, path.join(assets, name))
    names.push(name)
  }

  if (hasTextService(".")) {
    names.push((await downloadTipAsset(assets)).name)
  } else {
    logger.warning("No crates/kbd-tsf in this commit; publishing kbdgen only")
  }

  const { checksumFile, signatureFile } = await createSignedChecksums(
    names,
    await builder.secrets(),
    assets,
  )
  logger.info(`Publishing to ${KBDGEN_V4_TAG}: ${names.join(", ")}`)
  await new GitHub(builder.env.repo).updateRelease(
    KBDGEN_V4_TAG,
    [...names.map((name) => path.join(assets, name)), checksumFile, signatureFile],
    {
      draft: false,
      prerelease: true,
      name: `kbdgen v4 ${version}`,
    },
  )
}
