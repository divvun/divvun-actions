import * as path from "@std/path"
import { InnoSetupBuilder } from "~/util/inno.ts"
import logger from "~/util/log.ts"
import { Kbdgen } from "~/util/shared.ts"
import type { WindowsLayout } from "./layouts.ts"
import { WIND_DIRECTORY, WIND_FILES } from "./wind.ts"

const SYSTEM_FILE_FLAGS = [
  "restartreplace",
  "uninsrestartdelete",
  "ignoreversion",
]

/**
 * Write `install.all.iss` into `payloadDir`, the directory production kbdgen
 * wrote the layout DLLs to, staged with kbdi and Wind; Inno resolves the
 * relative sources against it. kbdgen v4 keyboards are built with outto
 * only (./outto.ts).
 */
export async function generateKbdInnoFromBundle(
  bundlePath: string,
  payloadDir: string,
  layouts: WindowsLayout[],
): Promise<string> {
  const bundle = await Kbdgen.loadTarget(bundlePath, "windows")
  const project = await Kbdgen.loadProjectBundle(bundlePath)

  const builder = new InnoSetupBuilder(Deno.cwd())

  builder
    .name(bundle.appName)
    .publisher(project.organisation)
    .version(bundle.version)
    .url(bundle.url)
    .productCode(`{${bundle.uuid}`)
    .defaultDirName("{pf}\\" + bundle.appName)
  builder.files((builder) => {
    builder.add(
      `kbdi.exe`,
      "{app}",
      SYSTEM_FILE_FLAGS,
      "not Is64BitInstallMode",
    )
    builder.add(
      `kbdi-x64.exe`,
      "{app}",
      SYSTEM_FILE_FLAGS,
      "Is64BitInstallMode",
      "kbdi.exe",
    )
    builder.add(
      `i386\\*`,
      "{sys}",
      SYSTEM_FILE_FLAGS,
      "not Is64BitInstallMode",
    )
    builder.add(
      `amd64\\*`,
      "{sys}",
      SYSTEM_FILE_FLAGS,
      "Is64BitInstallMode",
    )
    builder.add(
      `wow64\\*`,
      "{syswow64}",
      SYSTEM_FILE_FLAGS,
      "Is64BitInstallMode",
    )

    for (const name of WIND_FILES) {
      builder.add(
        `${WIND_DIRECTORY}/${name}`,
        "{app}\\dependencies\\divvun-wind",
        ["ignoreversion"],
      )
    }

    return builder
  })

  for (const layout of layouts) {
    addLayoutToInstaller(builder, layout)
  }
  builder.run((command) =>
    command
      .withFilename("{sys}\\WindowsPowerShell\\v1.0\\powershell.exe")
      .withParameter(
        '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\\dependencies\\divvun-wind\\install-wind.ps1""',
      )
      .withFlags(["runhidden", "waituntilterminated"])
  )
  const fileName = path.join(payloadDir, `install.all.iss`)
  logger.debug(builder.build())
  await builder.write(fileName)
  return fileName
}

/**
 * A product code as one quoted argument inside an Inno `Parameters: "..."`
 * string, where `""` is a literal quote and `{{` a literal brace.
 */
function innoProductCode(productCode: string): string {
  return `""${productCode.replaceAll("{", "{{")}""`
}

/**
 * Adds one layout's kbdi runs and shortcut. Production kbdgen's installers
 * install and enable the layout under the unclosed `{guid` product code and
 * uninstall the bare GUID.
 */
function addLayoutToInstaller(
  builder: InnoSetupBuilder,
  layout: WindowsLayout,
) {
  const productCode = innoProductCode(layout.legacyProductCode)
  builder
    .run((builder) => {
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_install")
        .withParameter(`-t ""${layout.languageCode}""`)
      if (layout.languageName) {
        builder.withParameter(`-l ""${layout.languageName}""`)
      }
      builder
        .withParameter(`-g ${productCode}`)
        .withParameter(`-d ${layout.dllName}`)
        .withParameter(`-n ""${layout.displayName}""`)
        .withParameter("-e")
        .withFlags(["runhidden", "waituntilterminated"])
      return builder
    })
  builder
    .uninstallRun((builder) => {
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_uninstall")
        .withParameter(innoProductCode(layout.guid))
        .withFlags(["runhidden", "waituntilterminated"])

      return builder
    })
    .icons((builder) => {
      builder
        .withName(`{group}\\Enable ${layout.displayName}`)
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_enable")
        .withParameter(`-g ${productCode}`)
        .withParameter(`-t ${layout.languageCode}`)
        .withFlags([
          "runminimized",
          "preventpinning",
          "excludefromshowinnewinstall",
        ])

      return builder
    })
}
