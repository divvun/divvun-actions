// Speller installer build path that uses outto instead of Inno Setup (Windows)
// or pkgbuild/productbuild (macOS).
//
// Opt-in: callers select this path via the `installer: "outto"` flag on
// spellerBundle(). Until the matching Pahkat upload type lands, this path
// stops at "signed artifact written to disk" — uploads still go through the
// legacy code path.

import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { makeOuttoInstaller } from "~/actions/outto/lib.ts"
import macosSign from "~/services/macos-codesign.ts"
import * as target from "~/target.ts"
import { makeTempDir } from "~/util/temp.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { type SpellerManifest, SpellerType } from "./manifest.ts"
import type { SpellerPaths } from "~/util/shared.ts"
import logger from "~/util/log.ts"

export type SpellerOuttoProps = {
  spellerType: SpellerType
  packageId: string
  langTag: string
  version: string
  buildNumber: number
  spellerName: string
  manifest: SpellerManifest
  spellerPaths: SpellerPaths
}

export type SpellerOuttoOutput = {
  payloadPath: string
  unsigned: boolean
}

export async function buildSpellerOutto(
  props: SpellerOuttoProps,
): Promise<SpellerOuttoOutput> {
  switch (props.spellerType) {
    case SpellerType.Windows:
      return await buildWindows(props)
    case SpellerType.MacOS:
      return await buildMacOS(props)
    default:
      throw new Error(
        `outto installer not supported for speller type: ${props.spellerType}`,
      )
  }
}

// ── Windows ────────────────────────────────────────────────────────────────

async function buildWindows(
  props: SpellerOuttoProps,
): Promise<SpellerOuttoOutput> {
  if (props.manifest.windows.system_product_code == null) {
    throw new Error("Missing system_product_code")
  }

  using stage = await makeTempDir({ prefix: "outto-speller-win-" })

  // Copy zhfst files into stage with their langTag-derived names.
  const zhfstNames: string[] = []
  for (const [key, src] of Object.entries(props.spellerPaths.desktop)) {
    const destName = `${key}.zhfst`
    await Deno.copyFile(src, path.join(stage.path, destName))
    zhfstNames.push(destName)
  }

  // Write speller.toml that maps langTag -> zhfst filename for spelli.
  const spellerToml: { spellers: Record<string, string> } = {
    spellers: { [props.langTag]: `${props.langTag}.zhfst` },
  }
  if (props.manifest.windows.extra_locales) {
    for (
      const [tag, prefix] of Object.entries(
        props.manifest.windows.extra_locales,
      )
    ) {
      spellerToml.spellers[tag] = `${prefix}.zhfst`
    }
  }
  await Deno.writeTextFile(
    path.join(stage.path, "speller.toml"),
    toml.stringify(spellerToml as Record<string, unknown>),
  )

  // Build the outto manifest in the stage.
  const oBuilder = new OuttoBuilder(stage.path, "windows")
    .id(props.packageId)
    .name(`${props.spellerName} Speller`)
    .version(props.version)
    .publisher("Universitetet i Tromsø - Norges arktiske universitet")
    .url("http://divvun.no/")
    .privileges("admin")
    .architecture("any")
    .defaultDir(`#{commonpf}/WinDivvun/Spellers/${props.langTag}`)

  // Files: each zhfst + speller.toml end up in #{app}.
  for (const name of zhfstNames) {
    oBuilder.file({ source: name, dest: "#{app}", overwrite: "always" })
  }
  oBuilder.file({
    source: "speller.toml",
    dest: "#{app}",
    overwrite: "always",
  })

  // Pre-existing legacy product-code uninstall (NSIS/MSI) — handled by outto's
  // install_cleanup.uninstall_ids when the kind matches its expectations. The
  // legacy_product_codes here are GUIDs of older installers we want to remove.
  if (props.manifest.windows.legacy_product_codes) {
    oBuilder.uninstallLegacyIds(
      props.manifest.windows.legacy_product_codes.map((p) => p.value),
    )
  }

  // Post-install + post-uninstall hooks: spelli refresh re-reads speller.toml
  // entries from WinDivvun.
  oBuilder.run({
    phase: "after_install",
    command: "#{commonpf}/WinDivvun/i686/spelli.exe",
    arguments: "refresh",
    wait: true,
    show: "hidden",
  })
  oBuilder.run({
    phase: "after_uninstall",
    command: "#{commonpf}/WinDivvun/i686/spelli.exe",
    arguments: "refresh",
    wait: true,
    show: "hidden",
  })

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

  return { payloadPath: result.path, unsigned: result.unsigned }
}

// ── macOS ──────────────────────────────────────────────────────────────────

async function buildMacOS(
  props: SpellerOuttoProps,
): Promise<SpellerOuttoOutput> {
  const zhfstFile = props.spellerPaths.desktop[props.langTag]
  if (!zhfstFile) {
    throw new Error(`Missing zhfst file for langTag ${props.langTag}`)
  }

  using stage = await makeTempDir({ prefix: "outto-speller-mac-" })

  const APP_NAME = "MacDivvun"
  const packageName = "no.divvun.MacDivvun"
  const bundleName = `${packageName}.${props.langTag}.bundle`
  const bundleDir = path.join(stage.path, bundleName)

  // Build the speller bundle (Info.plist + speller.zhfst). Same payload shape
  // as bundle-macos.ts:createBundle, just inlined here so the outto path is
  // self-contained.
  const contentsDir = path.join(bundleDir, "Contents")
  const resourcesDir = path.join(contentsDir, "Resources")
  await Deno.mkdir(resourcesDir, { recursive: true })
  await Deno.copyFile(zhfstFile, path.join(resourcesDir, "speller.zhfst"))
  await Deno.writeTextFile(
    path.join(contentsDir, "Info.plist"),
    bundleInfoPlist(
      props.langTag,
      props.version,
      props.buildNumber,
      APP_NAME,
      packageName,
    ),
  )

  // Codesign the bundle with the Developer ID Application identity. Must
  // happen before outto packages it so the signature is preserved.
  await codesignBundle(bundleDir)

  // outto manifest. Install location: /Library/Services/<bundle> via #{app}.
  const oBuilder = new OuttoBuilder(stage.path, "macos")
    .id(props.packageId)
    .name(`${props.spellerName} Speller`)
    .version(props.version)
    .publisher("Universitetet i Tromsø - Norges arktiske universitet")
    .url("http://divvun.no/")
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

  // Output: outto installer .app
  const outputName = `${props.packageId}_${props.version}_noarch-macos.app`
  const outputPath = path.resolve(outputName)

  const result = await makeOuttoInstaller({
    configPath,
    sourceDir: stage.path,
    outputPath,
    target: "macos",
  })

  // Notarise + staple the resulting installer .app.
  await macosSign(result.path)

  return { payloadPath: result.path, unsigned: false }
}

async function codesignBundle(bundleDir: string): Promise<void> {
  const appCodeSignId =
    "Developer ID Application: The University of Tromso (2K5J2584NX)"

  await builder.exec("security", ["find-identity", "-v", "-p", "codesigning"])
  await builder.exec("security", [
    "unlock-keychain",
    "-p",
    "admin",
    "/Users/admin/Library/Keychains/login.keychain-db",
  ])

  const result = await builder.output("timeout", [
    "60s",
    "codesign",
    "-f",
    "-v",
    "-s",
    appCodeSignId,
    bundleDir,
  ])

  if (result.status.code !== 0) {
    throw new Error(
      `bundle signing failed: ${result.stderr}\nexit code: ${result.status.code}`,
    )
  }
}

function bundleInfoPlist(
  bcp47code: string,
  version: string,
  build: number,
  appName: string,
  packageName: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleIdentifier</key>
\t<string>${packageName}.${bcp47code}</string>
\t<key>CFBundleName</key>
\t<string>${bcp47code}</string>
\t<key>CFBundlePackageType</key>
\t<string>BNDL</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${version}</string>
\t<key>CFBundleSupportedPlatforms</key>
\t<array>
\t\t<string>MacOSX</string>
\t</array>
\t<key>CFBundleVersion</key>
\t<string>${build}</string>
\t<key>NSHumanReadableCopyright</key>
\t<string>See license file.</string>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSExecutable</key>
\t\t\t<string>${appName}</string>
\t\t\t<key>NSLanguages</key>
\t\t\t<array>
\t\t\t\t<string>${bcp47code}</string>
\t\t\t</array>
\t\t\t<key>NSMenuItem</key>
\t\t\t<dict/>
\t\t\t<key>NSPortName</key>
\t\t\t<string>${appName}</string>
\t\t\t<key>NSSpellChecker</key>
\t\t\t<string>${appName}</string>
\t\t</dict>
\t</array>
</dict>
</plist>`
}
