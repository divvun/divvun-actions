import * as path from "@std/path"
import { InnoSetupBuilder } from "~/util/inno.ts"
import logger from "~/util/log.ts"
import { Kbdgen } from "~/util/shared.ts"
import type { WindowsLayout } from "./layouts.ts"
import { stageWindInstaller, WIND_DIRECTORY, WIND_FILES } from "./wind.ts"

const SYSTEM_FILE_FLAGS = [
  "restartreplace",
  "uninsrestartdelete",
  "ignoreversion",
]

/**
 * Write `install.all.iss` into `payloadDir`, the directory staged by
 * `stageInstallerPayload`; Inno resolves the relative sources against it.
 */
export async function generateKbdInnoFromBundle(
  bundlePath: string,
  payloadDir: string,
  layouts: WindowsLayout[],
): Promise<string> {
  const bundle = await Kbdgen.loadTarget(bundlePath, "windows")
  const project = await Kbdgen.loadProjectBundle(bundlePath)

  await stageWindInstaller(payloadDir)

  const builder = new InnoSetupBuilder(Deno.cwd())

  builder
    .name(bundle.appName)
    .publisher(project.organisation)
    .version(bundle.version)
    .url(bundle.url)
    .productCode(`{${bundle.uuid}`)
    .defaultDirName("{pf}\\" + bundle.appName)
    // 32-bit mode on x86 Windows; 64-bit mode (native {sys}, {syswow64}) on
    // x64 and on Arm64 Windows 11, which x64compatible also matches and where
    // kbdi-x64.exe runs under emulation. Arm64 Windows 10 cannot run x64
    // binaries, so it is refused rather than left without a working kbdi.
    .architectures({
      allowed: "x86os or x64compatible",
      installIn64BitMode: "x64compatible",
    })
    .files((builder) => {
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
      // kbdgen spec tsf.installer.layout-dlls; see LAYOUT_DLL_VARIANTS.
      builder.add(
        `x86\\*.dll`,
        "{sys}",
        SYSTEM_FILE_FLAGS,
        "not Is64BitInstallMode",
      )
      builder.add(
        `x64\\*.dll`,
        "{sys}",
        SYSTEM_FILE_FLAGS,
        "Is64BitInstallMode and IsX64OS",
      )
      builder.add(
        `arm64\\*.dll`,
        "{sys}",
        SYSTEM_FILE_FLAGS,
        "Is64BitInstallMode and IsArm64",
      )
      builder.add(
        `wow64\\*.dll`,
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

function addLayoutToInstaller(
  builder: InnoSetupBuilder,
  layout: WindowsLayout,
) {
  builder
    .run((builder) =>
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_uninstall")
        .withParameter(innoProductCode(layout.legacyProductCode))
        .withFlags(["runhidden", "waituntilterminated"])
    )
    .run((builder) => {
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_install")
        .withParameter(`-t ""${layout.languageCode}""`)
      if (layout.languageName) {
        builder.withParameter(`-l ""${layout.languageName}""`)
      }
      builder
        .withParameter(`-g ${innoProductCode(layout.productCode)}`)
        .withParameter(`-d ${layout.dllName}`)
        .withParameter(`-n ""${layout.displayName}""`)
        .withParameter("-e")
        .withFlags(["runhidden", "waituntilterminated"])
      return builder
    })
    .uninstallRun((builder) => {
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_uninstall")
        .withParameter(innoProductCode(layout.productCode))
        .withFlags(["runhidden", "waituntilterminated"])

      return builder
    })
    .icons((builder) => {
      builder
        .withName(`{group}\\Enable ${layout.displayName}`)
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_enable")
        .withParameter(`-g ${innoProductCode(layout.productCode)}`)
        .withParameter(`-t ${layout.languageCode}`)
        .withFlags([
          "runminimized",
          "preventpinning",
          "excludefromshowinnewinstall",
        ])

      return builder
    })
}
