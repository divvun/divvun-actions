// Build the proofing packages, proofing-<tag>.
//
// A proofing package ships a single Divvun Runtime Bundle (.drb), containing
// spelling and optionally grammar functionality, wrapped per-OS so the desktop
// consumers (the MacDivvun service and the LibreOffice extension) find it in the
// unified `proofing` location:
//
//   macOS:   outto .app that installs no.divvun.proofing.<tag>.bundle (holding
//            Contents/Resources/<tag>.drb) into /Library/Services. Both consumers
//            scan the Services dir and match the no.divvun.proofing. prefix.
//   Windows: outto .exe that installs <tag>.drb into %ProgramData%\Divvun\Proofing.
//   Linux:   .pkt.box holding <tag>.drb at its root.
//
// They are published as the proofing release on GitHub (see
// pipelines/lang/mod.ts).

import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeOuttoInstaller } from "~/actions/outto/lib.ts"
import macosSign from "~/services/macos-codesign.ts"
import * as target from "~/target.ts"
import { APP_CODESIGN_ID, codesignBundle } from "~/util/codesign-bundle.ts"
import { createPktBox } from "~/util/pkt_box.ts"
import { Ditto } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import logger from "~/util/log.ts"

const PUBLISHER = "Universitetet i Tromsø - Norges arktiske universitet"
const PROJECT_URL = "http://divvun.no/"
/** Stable DNS-style bundle prefix the consumers match on. */
const BUNDLE_PREFIX = "no.divvun.proofing"

export type ProofingTarget = "macos" | "windows" | "linux"

export type ProofingBundleProps = {
  target: ProofingTarget
  /** Package id, e.g. proofing-se. */
  packageId: string
  /** BCP-47 tag, e.g. se. Names the .drb and (macOS) the bundle dir. */
  langTag: string
  /** Human-readable installer name. */
  name: string
  version: string
  buildNumber: number
  /** Source .drb (installed/shipped as <tag>.drb). */
  drbPath: string
}

export type ProofingBundleOutput = {
  /** Path to the uploaded artifact. */
  payloadPath: string
  unsigned: boolean
}

export default async function proofingBundle(
  props: ProofingBundleProps,
): Promise<ProofingBundleOutput> {
  logger.debug(
    `Proofing bundle for ${props.target} ${props.langTag} v${props.version}`,
  )
  switch (props.target) {
    case "macos":
      return await buildMacOS(props)
    case "windows":
      return await buildWindows(props)
    case "linux":
      return await buildLinux(props)
  }
}

// ── macOS ──────────────────────────────────────────────────────────────────

async function buildMacOS(
  props: ProofingBundleProps,
): Promise<ProofingBundleOutput> {
  using stage = await makeTempDir({ prefix: "outto-proofing-mac-" })

  const bundleName = `${BUNDLE_PREFIX}.${props.langTag}.bundle`
  const bundleDir = path.join(stage.path, bundleName)
  const resourcesDir = path.join(bundleDir, "Contents", "Resources")
  await Deno.mkdir(resourcesDir, { recursive: true })
  await Deno.copyFile(
    props.drbPath,
    path.join(resourcesDir, `${props.langTag}.drb`),
  )
  await Deno.writeTextFile(
    path.join(bundleDir, "Contents", "Info.plist"),
    bundleInfoPlist(props.langTag, props.version, props.buildNumber),
  )

  // Sign the bundle before outto packages it, so the signature is preserved.
  await codesignBundle(bundleDir, APP_CODESIGN_ID)

  const oBuilder = new OuttoBuilder(stage.path, "macos")
    // outto requires a reverse-DNS package id (must contain a dot). The
    // proofing-<tag> package id lives in the artifact filename only; this
    // matches the bundle's CFBundleIdentifier.
    .id(`${BUNDLE_PREFIX}.${props.langTag}`)
    .name(props.name)
    .version(props.version)
    .publisher(PUBLISHER)
    .url(PROJECT_URL)
    .defaultDir(`#{library}/Services/${bundleName}`)
    .privileges("admin")
    .upgradePolicy("overwrite")
    .removeAppDirOnUninstall(true)
    .file({
      source: bundleName,
      dest: "#{library}/Services",
      bundle: true,
      overwrite: "always",
    })

  const configPath = path.join(stage.path, "outto.toml")
  await oBuilder.write(configPath)

  const outputName = `${props.packageId}_${props.version}_noarch-macos.app`
  const outputPath = path.resolve(outputName)

  const result = await makeOuttoInstaller({
    configPath,
    sourceDir: stage.path,
    outputPath,
    target: "macos",
  })

  // Notarise + staple the installer .app.
  await macosSign(result.path)

  // Buildkite artifact upload wants a file: ditto-zip the .app (preserves the
  // signature, xattrs and symlinks).
  const uploadPath = `${result.path}.zip`
  await Ditto.zipApp(result.path, uploadPath)
  logger.debug(`Zipped .app for upload: ${uploadPath}`)

  await builder.uploadArtifacts(uploadPath)
  return { payloadPath: uploadPath, unsigned: false }
}

// ── Windows ──────────────────────────────────────────────────────────────────

async function buildWindows(
  props: ProofingBundleProps,
): Promise<ProofingBundleOutput> {
  using stage = await makeTempDir({ prefix: "outto-proofing-win-" })

  const drbName = `${props.langTag}.drb`
  await Deno.copyFile(props.drbPath, path.join(stage.path, drbName))

  // Install into the shared %ProgramData%\Divvun\Proofing dir (#{commonappdata}
  // = %ProgramData%). removeAppDirOnUninstall stays false so removing one
  // language leaves the shared dir (and other languages' .drb) intact; outto
  // still removes the tracked <tag>.drb file itself.
  const oBuilder = new OuttoBuilder(stage.path, "windows")
    // outto requires a reverse-DNS package id (must contain a dot). The
    // proofing-<tag> package id lives in the artifact filename only.
    .id(`${BUNDLE_PREFIX}.${props.langTag}`)
    .name(props.name)
    .version(props.version)
    .publisher(PUBLISHER)
    .url(PROJECT_URL)
    .privileges("admin")
    .architecture("any")
    .defaultDir("#{commonappdata}/Divvun/Proofing")
    .upgradePolicy("overwrite")
    .removeAppDirOnUninstall(false)
    .file({ source: drbName, dest: "#{app}", overwrite: "always" })

  const configPath = path.join(stage.path, "outto.toml")
  await oBuilder.write(configPath)

  const outputName = `${props.packageId}_${props.version}_noarch-windows.exe`
  const outputPath = path.resolve(outputName)

  // Sign command: existing divvun-actions.bat wraps signtool.
  const signCommand = `${target.projectPath}\\bin\\divvun-actions.bat sign`

  let result: { path: string; unsigned: boolean }
  try {
    result = await makeOuttoInstaller({
      configPath,
      sourceDir: stage.path,
      outputPath,
      target: "windows",
      signCommand,
    })
  } catch (err) {
    logger.warning(
      `outto build with signing failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    logger.warning("Retrying outto build without signing...")
    const unsignedOutput = path.resolve(
      `${props.packageId}_${props.version}_noarch-windows.UNSIGNED.exe`,
    )
    result = await makeOuttoInstaller({
      configPath,
      sourceDir: stage.path,
      outputPath: unsignedOutput,
      target: "windows",
    })
  }

  await builder.uploadArtifacts(result.path)
  return { payloadPath: result.path, unsigned: result.unsigned }
}

// ── Linux ────────────────────────────────────────────────────────────────────

async function buildLinux(
  props: ProofingBundleProps,
): Promise<ProofingBundleOutput> {
  const outputName = `${props.packageId}_${props.version}_noarch-linux.pkt.box`
  const outputPath = path.resolve(outputName)
  await createPktBox(outputPath, {
    pkg: props.packageId,
    version: props.version,
    files: [{ path: props.drbPath, name: `${props.langTag}.drb` }],
  })
  logger.debug(`Created Linux proofing package at ${outputPath}`)

  await builder.uploadArtifacts(outputPath)
  return { payloadPath: outputPath, unsigned: false }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal Info.plist for the proofing bundle. No NSServices: the MacDivvun
 * service registers languages from the discovered .drb files, not from the
 * per-bundle plist. CFBundleIdentifier gives codesign/pkg tooling a stable id.
 */
function bundleInfoPlist(
  tag: string,
  version: string,
  build: number,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleIdentifier</key>
\t<string>${BUNDLE_PREFIX}.${tag}</string>
\t<key>CFBundleName</key>
\t<string>${tag}</string>
\t<key>CFBundlePackageType</key>
\t<string>BNDL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
\t<key>CFBundleVersion</key>
\t<string>${build}</string>
\t<key>NSHumanReadableCopyright</key>
\t<string>See license file.</string>
</dict>
</plist>`
}
