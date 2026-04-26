// Keyboard Windows installer build path that uses outto instead of Inno Setup.
//
// Opt-in: callers select this path via the `installer: "outto"` flag on
// keyboardBuild() (see ./mod.ts). Until the matching Pahkat upload type
// lands, this path stops at "signed artifact written to disk".

// deno-lint-ignore-file no-explicit-any
import * as path from "@std/path"
import * as uuid from "@std/uuid"
import { makeOuttoInstaller } from "~/actions/outto/lib.ts"
import * as target from "~/target.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { Kbdgen } from "~/util/shared.ts"
import logger from "~/util/log.ts"

export type OuttoKeyboardResult = {
  path: string
  unsigned: boolean
}

const textEncoder = new TextEncoder()
const KBDGEN_NAMESPACE = await uuid.v5.generate(
  uuid.NAMESPACE_DNS,
  textEncoder.encode("divvun.no"),
)

function layoutTarget(layout: { [key: string]: any }) {
  const targets = layout["windows"] || {}
  return targets["config"] || {}
}

function getKbdId(locale: string, layout: { [key: string]: any }) {
  if ("id" in layout) {
    return "kbd" + layout["id"]
  }
  return "kbd" + locale.replace(/[^A-Za-z0-9-]/g, "").substr(0, 5)
}

/**
 * Generate an outto manifest + run `outto build` for a kbdgen Windows
 * keyboard bundle. Mirrors the inputs of generateKbdInnoFromBundle().
 *
 * `bundlePath` is the kbdgen bundle dir; `buildDir` is the dir where kbdgen
 * has already staged the architecture sub-dirs (i386/, amd64/, wow64/) and
 * the kbdi.exe / kbdi-x64.exe binaries.
 */
export async function buildKeyboardWindowsOutto(
  bundlePath: string,
  buildDir: string,
): Promise<OuttoKeyboardResult> {
  const bundle = await Kbdgen.loadTarget(bundlePath, "windows")
  const project = await Kbdgen.loadProjectBundle(bundlePath)
  const layouts = await Kbdgen.loadLayouts(bundlePath)

  const oBuilder = new OuttoBuilder(buildDir, "windows")
    .id(`{${bundle.uuid}}`)
    .name(bundle.appName)
    .version(bundle.version)
    .publisher(project.organisation)
    .url(bundle.url)
    .privileges("admin")
    .architecture("any")
    .defaultDir(`#{pf}/${bundle.appName}`)

  // kbdi binaries: 32-bit hosts get kbdi.exe, 64-bit hosts get kbdi-x64.exe
  // renamed to kbdi.exe so the run hooks can reference a single name.
  oBuilder.file({
    source: "kbdi.exe",
    dest: "#{app}",
    arch: "x86",
    overwrite: "always",
  })
  oBuilder.file({
    source: "kbdi-x64.exe",
    dest: "#{app}",
    arch: "x64",
    dest_name: "kbdi.exe",
    overwrite: "always",
  })

  // System DLLs:
  //   i386/   → System32 on 32-bit Windows
  //   amd64/  → System32 on 64-bit Windows
  //   wow64/  → SysWOW64 (32-bit emulation dir) on 64-bit Windows
  oBuilder.file({
    source: "i386/*",
    dest: "#{sys}",
    arch: "x86",
    overwrite: "always",
  })
  oBuilder.file({
    source: "amd64/*",
    dest: "#{sys}",
    arch: "x64",
    overwrite: "always",
  })
  oBuilder.file({
    source: "wow64/*",
    dest: "C:/Windows/SysWOW64",
    arch: "x64",
    overwrite: "always",
  })

  for (const [locale, layout] of Object.entries(layouts)) {
    if ("windows" in layout) {
      await addLayoutToOuttoManifest(oBuilder, locale, layout)
    }
  }

  const configPath = path.join(buildDir, "outto.toml")
  await oBuilder.write(configPath)
  logger.debug(`outto manifest written: ${configPath}`)

  // Output beside the build dir so the surrounding rename-to-payload-path
  // logic can pick it up.
  const outputName = `install.exe`
  const outputPath = path.join(buildDir, outputName)
  const signCommand = `${target.projectPath}\\bin\\divvun-actions.bat sign`

  let result: { path: string; unsigned: boolean }
  try {
    result = await makeOuttoInstaller({
      configPath,
      sourceDir: buildDir,
      outputPath,
      target: "windows",
      signCommand,
    })
  } catch (err) {
    logger.warning(
      `outto build with signing failed: ${
        err instanceof Error ? err.message : String(err)
      }; retrying without signing`,
    )
    result = await makeOuttoInstaller({
      configPath,
      sourceDir: buildDir,
      outputPath,
      target: "windows",
    })
  }

  return result
}

async function addLayoutToOuttoManifest(
  oBuilder: OuttoBuilder,
  locale: string,
  layout: { [key: string]: any },
): Promise<void> {
  const target = layoutTarget(layout)
  const kbdId = getKbdId(locale, target)
  const dllName = kbdId + ".dll"
  const languageCode = target["locale"] || locale
  const languageName = target["languageName"]
  const layoutDisplayName = layout["displayNames"][locale]
  const guidStr = await uuid.v5.generate(
    KBDGEN_NAMESPACE,
    textEncoder.encode(kbdId),
  )
  if (!layoutDisplayName) {
    throw new Error(`Display name for ${locale} not found`)
  }

  const installArgs: string[] = [
    "keyboard_install",
    "-t",
    `"${languageCode}"`,
  ]
  if (languageName) {
    installArgs.push("-l", `"${languageName}"`)
  }
  installArgs.push("-g", `"{${guidStr}}"`)
  installArgs.push("-d", dllName)
  installArgs.push("-n", `"${layoutDisplayName}"`)
  installArgs.push("-e")

  oBuilder.run({
    phase: "after_install",
    command: "#{app}/kbdi.exe",
    arguments: installArgs.join(" "),
    wait: true,
    show: "hidden",
  })

  oBuilder.run({
    phase: "before_uninstall",
    command: "#{app}/kbdi.exe",
    arguments: `keyboard_uninstall "{${guidStr}}"`,
    wait: true,
    show: "hidden",
  })

  oBuilder.shortcut({
    name: `Enable ${layoutDisplayName}`,
    target: "#{app}/kbdi.exe",
    location: "start_menu",
    arguments: `keyboard_enable -g "{${guidStr}}" -t ${languageCode}`,
    description: `Enable ${layoutDisplayName} keyboard layout`,
  })
}
