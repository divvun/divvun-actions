// A keyboard-* build's Pahkat package, main/<repository name>, such as
// main/keyboard-sme. Each kbdgen target carries its own version, so the
// Windows and macOS installers are one release when their versions agree
// and a release each when they do not.

import { exists } from "@std/fs"
import * as path from "@std/path"
import { keyboardPackageId } from "~/actions/keyboard/build/outto.ts"
import * as builder from "~/builder.ts"
import { ExpectedError } from "~/util/error.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import {
  type ArtifactSource,
  byVersion,
  downloadArtifacts,
  type Metadata,
  publishRelease,
  repositoryLicense,
} from "~/util/pahkat.ts"
import { Kbdgen } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import { desktopKeyboardBundlePath } from "./divvun-keyboard.ts"

/**
 * Which of the keyboard's Pahkat artifacts make up its releases, and what
 * each is. Either build may have failed, so each is optional, and a bundle
 * without a macOS target, such as a format 4 one, builds only Windows. The
 * outto ids are the ones actions/keyboard/build/outto.ts builds with.
 */
async function keyboardArtifacts(
  bundlePath: string,
): Promise<ArtifactSource[]> {
  const sources: ArtifactSource[] = [{
    name: "*_windows*.exe",
    kind: "outto-windows",
    outtoId: keyboardPackageId(bundlePath),
    optional: true,
  }]
  if (await exists(path.join(bundlePath, "targets", "macos.yaml"))) {
    const macos = await Kbdgen.loadTarget(bundlePath, "macos")
    sources.push({
      name: "*_macos.app.zip",
      kind: "outto-macos",
      outtoId: `${macos.packageId}.keyboardlayout.${macos.bundleName}`,
      optional: true,
    })
  }
  return sources
}

/**
 * The keyboard's names and descriptions from its kbdgen project's locales,
 * and its languages from its layouts, `layouts/<tag>.yaml`, by their
 * language subtag.
 */
async function keyboardMetadata(bundlePath: string): Promise<Metadata> {
  const project = await Kbdgen.loadProjectBundleWithoutProxy(bundlePath) as {
    locales?: Record<string, { name?: string; description?: string }>
    author?: string
    organisation?: string
  }
  const names: Record<string, string> = {}
  const descriptions: Record<string, string> = {}
  for (const [tag, locale] of Object.entries(project.locales ?? {})) {
    if (locale.name) names[tag] = locale.name
    if (locale.description) descriptions[tag] = locale.description
  }
  const languages = new Set<string>()
  for await (const entry of Deno.readDir(path.join(bundlePath, "layouts"))) {
    if (entry.isFile && entry.name.endsWith(".yaml")) {
      languages.add(entry.name.split(/[.-]/, 1)[0])
    }
  }
  const author = project.author ?? project.organisation
  return {
    names,
    descriptions,
    authors: author ? [author] : [],
    ...await repositoryLicense(),
    languages: [...languages].sort(),
    tags: ["cat:keyboard-layouts"],
  }
}

/**
 * Publish the keyboard installers a release tag or main build made, each
 * under the version its name carries. A private repository's keyboards are
 * not published.
 */
export async function runKeyboardPahkatPublish() {
  if (await new GitHub(builder.env.repo).isPrivate()) {
    logger.info(`Not publishing ${builder.env.repoName} to Pahkat: it is private`)
    return
  }

  const id = builder.env.repoName
  const bundlePath = desktopKeyboardBundlePath()
  using dir = await makeTempDir({ prefix: "pahkat-keyboard-" })
  const artifacts = await downloadArtifacts(
    id,
    await keyboardArtifacts(bundlePath),
    dir.path,
  )
  if (artifacts.length === 0) {
    throw ExpectedError.create(
      "No signed keyboard installer to publish. The publish runs even when the builds fail, so check whether they made one.",
    )
  }

  const metadata = await keyboardMetadata(bundlePath)
  for (const [version, release] of byVersion(artifacts, id)) {
    await publishRelease({
      package: id,
      version,
      tag: builder.env.tag || "dev-latest",
      metadata,
      artifacts: release,
    })
  }
}
