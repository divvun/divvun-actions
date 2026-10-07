// What both Windows keyboard installers (Inno Setup and outto) need to know
// about a kbdgen bundle's layouts and, for kbdgen v4, the layout DLLs kbdgen
// built for them.

// deno-lint-ignore-file no-explicit-any
import * as path from "@std/path"
import * as uuid from "@std/uuid"
import logger from "~/util/log.ts"
import { Kbdgen } from "~/util/shared.ts"

/**
 * The layout DLL variants kbdgen builds into `<out>/<variant>/<name>.dll`
 * (kbdgen spec `kbdl.build`), and where the installers place them
 * (`tsf.installer.layout-dlls`):
 *
 * | Windows | System32 | SysWOW64 |
 * |---------|----------|----------|
 * | x64     | `x64`    | `wow64`  |
 * | Arm64   | `arm64`  | `wow64`  |
 * | x86     | `x86`    | —        |
 *
 * `wow64` is a 32-bit x86 image with 64-bit table layout: the 64-bit kernel
 * reads the tables of the file a 32-bit process loads from SysWOW64, so a
 * plain `x86` DLL there fails to load (`kbdl.wow64`). Microsoft's file
 * system redirector sends 32-bit x86 processes to SysWOW64 on Arm64 as on
 * x64, so the same `wow64` DLL serves both.
 *
 * The installers take each variant's directory unchanged from the payload
 * directory staged by {@link stageInstallerPayload}.
 */
export const LAYOUT_DLL_VARIANTS = ["x86", "x64", "arm64", "wow64"] as const

export type LayoutDllVariant = typeof LAYOUT_DLL_VARIANTS[number]

export type WindowsLayout = {
  locale: string
  /** kbdgen's keyboard name, `kbd<id>`; the DLL is `<kbdId>.dll`. */
  kbdId: string
  dllName: string
  languageCode: string
  languageName: string | undefined
  displayName: string
  /** The layout's GUID, unbraced, derived from `kbdId`. */
  guid: string
  /**
   * The braced `{guid}` passed to every kbdi command. kbdi stores it as the
   * layout's `Layout Product Code` on `keyboard_install` and finds the layout
   * by comparing that value byte for byte on `keyboard_enable` and
   * `keyboard_uninstall`, so all three must pass this exact string.
   */
  productCode: string
  /**
   * The `{guid` form (no closing brace) that older Inno installers
   * registered. Installing removes a layout registered under it, which the
   * uninstaller would otherwise never find.
   */
  legacyProductCode: string
}

const textEncoder = new TextEncoder()
const KBDGEN_NAMESPACE = await uuid.v5.generate(
  uuid.NAMESPACE_DNS,
  textEncoder.encode("divvun.no"),
)

/**
 * Whether kbdgen builds a Windows layout DLL from the layout. A format 4
 * layout has a Windows document when its `hardware` has a `windows` or a
 * `default` variant (kbdgen spec `ldml.yaml.hosts`); an older one when it
 * has a `windows` section.
 */
function hasWindowsInput(layout: { [key: string]: any }): boolean {
  if (layout["format"] === 4) {
    const hardware = layout["hardware"] || {}
    return "windows" in hardware || "default" in hardware
  }
  return "windows" in layout
}

/**
 * The layout's Windows configuration: `targets.windows` in format 4, which
 * has `id` and `locale` (kbdgen spec `ldml.yaml.targets`); `windows.config`
 * before, which may also have `languageName`.
 */
function layoutTarget(layout: { [key: string]: any }) {
  if (layout["format"] === 4) {
    return layout["targets"]?.["windows"] || {}
  }
  const targets = layout["windows"] || {}
  return targets["config"] || {}
}

function getKbdId(locale: string, target: { [key: string]: any }) {
  if ("id" in target) {
    return "kbd" + target["id"]
  }
  return "kbd" + locale.replace(/[^A-Za-z0-9-]/g, "").substr(0, 5)
}

/** The bundle's layouts that have Windows input, in bundle order. */
export async function loadWindowsLayouts(
  bundlePath: string,
): Promise<WindowsLayout[]> {
  const layouts = await Kbdgen.loadLayouts(bundlePath)
  const result: WindowsLayout[] = []
  for (const [locale, layout] of Object.entries(layouts)) {
    if (!hasWindowsInput(layout)) {
      continue
    }
    const target = layoutTarget(layout)
    const kbdId = getKbdId(locale, target)
    const displayName = layout["displayNames"]?.[locale]
    if (!displayName) {
      throw new Error(`Display name for ${locale} not found`)
    }
    const guid = await uuid.v5.generate(
      KBDGEN_NAMESPACE,
      textEncoder.encode(kbdId),
    )
    result.push({
      locale,
      kbdId,
      dllName: kbdId + ".dll",
      languageCode: target["locale"] || locale,
      languageName: target["languageName"],
      displayName,
      guid,
      productCode: `{${guid}}`,
      legacyProductCode: `{${guid}`,
    })
  }
  return result
}

/**
 * Stage everything the Windows installers ship into `payloadDir`, which must
 * not exist yet:
 *
 * - `<variant>/<kbdId>.dll` for every layout and every
 *   {@link LAYOUT_DLL_VARIANTS} entry, copied unchanged from kbdgen's
 *   `<kbdgenOutput>/<variant>/`
 * - `kbdi.exe` (x86) and `kbdi-x64.exe` from the given kbdi `bin` directory
 *
 * kbdgen's output directory also holds the generated layout crates and their
 * cargo target directories (`<out>/build/`), which must not end up in the
 * installer, so the installers read only this directory.
 *
 * Fails, naming every missing file, unless every layout has every variant: an
 * installer without the `wow64` DLL breaks the layout for 32-bit apps on x64,
 * and one without the `arm64` DLL breaks it everywhere on Arm64.
 */
export async function stageInstallerPayload(opts: {
  kbdgenOutput: string
  kbdiBinDir: string
  payloadDir: string
  layouts: WindowsLayout[]
}): Promise<void> {
  const { kbdgenOutput, kbdiBinDir, payloadDir, layouts } = opts
  if (layouts.length === 0) {
    throw new Error("The bundle has no layouts with Windows input")
  }

  const variants = LAYOUT_DLL_VARIANTS.join(", ")
  const missing: string[] = []
  for (const variant of LAYOUT_DLL_VARIANTS) {
    for (const layout of layouts) {
      const source = path.join(kbdgenOutput, variant, layout.dllName)
      if (!await isFile(source)) {
        missing.push(source)
      }
    }
  }
  if (missing.length > 0) {
    const files = missing.join("\n  ")
    throw new Error(
      `kbdgen did not build every layout DLL variant (${variants}); ` +
        `missing:\n  ${files}\nA kbdgen without its own Windows layout ` +
        `DLL build (kbdl) cannot produce these.`,
    )
  }

  await Deno.mkdir(payloadDir)
  for (const variant of LAYOUT_DLL_VARIANTS) {
    await Deno.mkdir(path.join(payloadDir, variant))
    for (const layout of layouts) {
      await Deno.copyFile(
        path.join(kbdgenOutput, variant, layout.dllName),
        path.join(payloadDir, variant, layout.dllName),
      )
    }
  }
  const dlls = layouts.map((l) => l.dllName).join(", ")
  logger.debug(`Staged ${dlls} for ${variants} in ${payloadDir}`)

  for (const name of ["kbdi.exe", "kbdi-x64.exe"]) {
    await Deno.copyFile(
      path.join(kbdiBinDir, name),
      path.join(payloadDir, name),
    )
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await Deno.stat(filePath)).isFile
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return false
    }
    throw e
  }
}
