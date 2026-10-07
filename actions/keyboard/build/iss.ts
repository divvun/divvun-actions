import * as path from "@std/path"
import { InnoSetupBuilder } from "~/util/inno.ts"
import logger from "~/util/log.ts"
import { Kbdgen } from "~/util/shared.ts"
import type { WindowsLayout } from "./layouts.ts"
import type { KeyboardToolchain } from "./toolchain.ts"
import { WIND_DIRECTORY, WIND_FILES } from "./wind.ts"
import {
  TIP_APP_DIR,
  TIP_SILENT_ARGS,
  TIP_UNINSTALLER,
} from "~/actions/kbd-tsf/installer.ts"
import { TIP_DIRECTORY, TIP_INSTALL_ARGS, TIP_INSTALLER } from "./tip.ts"

type FilesBuilder = Parameters<Parameters<InnoSetupBuilder["files"]>[0]>[0]

const SYSTEM_FILE_FLAGS = [
  "restartreplace",
  "uninsrestartdelete",
  "ignoreversion",
]

const TIP_APP_SUBDIR = TIP_DIRECTORY.replaceAll("/", "\\")

/**
 * Write `install.all.iss` into `payloadDir`, the directory staged with the
 * layout DLLs, kbdi, Wind and (v4) the text service; Inno resolves the
 * relative sources against it.
 */
export async function generateKbdInnoFromBundle(
  bundlePath: string,
  payloadDir: string,
  layouts: WindowsLayout[],
  toolchain: KeyboardToolchain,
): Promise<string> {
  const v4 = toolchain.kind === "v4"
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
  if (v4) {
    // 32-bit mode on x86 Windows; 64-bit mode (native {sys}, {syswow64}) on
    // x64 and on Arm64 Windows 11, which x64compatible also matches and where
    // kbdi-x64.exe runs under emulation. Arm64 Windows 10 cannot run x64
    // binaries, so it is refused rather than left without a working kbdi.
    builder.architectures({
      allowed: "x86os or x64compatible",
      installIn64BitMode: "x64compatible",
    })
  }
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
    if (v4) {
      addLayoutDllVariants(builder)
      builder.add(
        `${TIP_DIRECTORY}/${TIP_INSTALLER}`,
        `{app}\\${TIP_APP_SUBDIR}`,
        ["ignoreversion"],
      )
    } else {
      addLegacyLayoutDlls(builder)
    }

    for (const name of WIND_FILES) {
      builder.add(
        `${WIND_DIRECTORY}/${name}`,
        "{app}\\dependencies\\divvun-wind",
        ["ignoreversion"],
      )
    }

    return builder
  })

  if (v4) {
    // kbdgen spec tsf.installer.bundle: the text service before any
    // keyboard_install, so kbdi registers each layout's profile. Inno ignores
    // [Run] exit codes, so a failed text service setup leaves the keyboards
    // on their layouts (tsf.register.enable).
    builder.run((command) =>
      command
        .withFilename(`{app}\\${TIP_APP_SUBDIR}\\${TIP_INSTALLER}`)
        .withParameter(TIP_INSTALL_ARGS)
        .withFlags(["runhidden", "waituntilterminated"])
    )
  }
  for (const layout of layouts) {
    addLayoutToInstaller(
      builder,
      layout,
      v4 ? v4ProductCodes(layout) : legacyProductCodes(layout),
      v4,
    )
  }
  if (v4) {
    // After every keyboard_uninstall: Windows ignores the removal of a TIP
    // string once the text service is unregistered. The text service's
    // uninstaller refuses while another keyboard's profile remains
    // (tsf.register.uninstall), so this removes it with the last keyboard.
    builder.uninstallRun((command) =>
      command
        .withFilename(`{commonpf}\\${TIP_APP_DIR}\\${TIP_UNINSTALLER}`)
        .withParameter(TIP_SILENT_ARGS)
        .withFlags(["runhidden", "waituntilterminated", "skipifdoesntexist"])
    )
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

/** Production kbdgen's `x86` DLLs as `i386` and `wow64`, its `x64` as `amd64`. */
function addLegacyLayoutDlls(builder: FilesBuilder) {
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
}

/** kbdgen spec tsf.installer.layout-dlls; see LAYOUT_DLL_VARIANTS. */
function addLayoutDllVariants(builder: FilesBuilder) {
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
}

/** The product codes one layout's kbdi commands pass. */
type ProductCodes = {
  /** For `keyboard_install` and `keyboard_enable`. */
  install: string
  uninstall: string
  /** Uninstalled before `keyboard_install`. */
  replaces?: string
}

/**
 * What installers built with production kbdgen pass: the unclosed `{guid` to
 * install and enable, the bare GUID to uninstall.
 */
function legacyProductCodes(layout: WindowsLayout): ProductCodes {
  return { install: layout.legacyProductCode, uninstall: layout.guid }
}

/**
 * The braced product code everywhere, replacing a layout that an older
 * installer registered under the unclosed one.
 */
function v4ProductCodes(layout: WindowsLayout): ProductCodes {
  return {
    install: layout.productCode,
    uninstall: layout.productCode,
    replaces: layout.legacyProductCode,
  }
}

/**
 * A product code as one quoted argument inside an Inno `Parameters: "..."`
 * string, where `""` is a literal quote and `{{` a literal brace.
 */
function innoProductCode(productCode: string): string {
  return `""${productCode.replaceAll("{", "{{")}""`
}

/**
 * Adds one layout's kbdi runs and shortcut. `welcomeScreen` also offers the
 * layout on the welcome screen once it is installed and enabled (kbdgen spec
 * tsf.register.welcome), which only kbdi with text service profiles can do;
 * its `keyboard_uninstall` takes the layout off the welcome screen again.
 */
function addLayoutToInstaller(
  builder: InnoSetupBuilder,
  layout: WindowsLayout,
  codes: ProductCodes,
  welcomeScreen: boolean,
) {
  const { replaces } = codes
  if (replaces) {
    builder.run((builder) =>
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_uninstall")
        .withParameter(innoProductCode(replaces))
        .withFlags(["runhidden", "waituntilterminated"])
    )
  }
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
        .withParameter(`-g ${innoProductCode(codes.install)}`)
        .withParameter(`-d ${layout.dllName}`)
        .withParameter(`-n ""${layout.displayName}""`)
        .withParameter("-e")
        .withFlags(["runhidden", "waituntilterminated"])
      return builder
    })
  if (welcomeScreen) {
    builder.run((builder) =>
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_enable")
        .withParameter(`-g ${innoProductCode(codes.install)}`)
        .withParameter(`-t ""${layout.languageCode}""`)
        .withParameter("--default-user")
        .withFlags(["runhidden", "waituntilterminated"])
    )
  }
  builder
    .uninstallRun((builder) => {
      builder
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_uninstall")
        .withParameter(innoProductCode(codes.uninstall))
        .withFlags(["runhidden", "waituntilterminated"])

      return builder
    })
    .icons((builder) => {
      builder
        .withName(`{group}\\Enable ${layout.displayName}`)
        .withFilename("{app}\\kbdi.exe")
        .withParameter("keyboard_enable")
        .withParameter(`-g ${innoProductCode(codes.install)}`)
        .withParameter(`-t ${layout.languageCode}`)
        .withFlags([
          "runminimized",
          "preventpinning",
          "excludefromshowinnewinstall",
        ])

      return builder
    })
}
