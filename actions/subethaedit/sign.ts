import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

const IDENTITY = "Developer ID Application"

interface CodesignOptions {
  /** Path to an entitlements plist to embed. Frameworks must not get one. */
  entitlements?: string
  /** Identifier prefix (codesign --prefix), used for loose binaries like luac. */
  prefix?: string
}

/**
 * Sign a single component with a hardened runtime and a secure timestamp.
 * Both are required for notarization; the repo's own SEEThirdPartyResign.sh
 * omits them, which is why divvun-actions signs everything itself.
 */
async function codesignDeep(target: string, options: CodesignOptions = {}) {
  const args = [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--sign",
    IDENTITY,
  ]

  if (options.prefix != null) {
    args.push("--prefix", options.prefix)
  }

  if (options.entitlements != null) {
    args.push("--entitlements", options.entitlements)
  }

  args.push(target)

  logger.info(`codesign: ${path.basename(target)}`)
  await builder.exec("codesign", args)
}

async function expandDirs(pattern: string): Promise<string[]> {
  const result: string[] = []
  for await (const entry of fs.expandGlob(pattern)) {
    if (entry.isDirectory) {
      result.push(entry.path)
    }
  }
  return result
}

async function expandFiles(pattern: string): Promise<string[]> {
  const result: string[] = []
  for await (const entry of fs.expandGlob(pattern)) {
    if (entry.isFile) {
      result.push(entry.path)
    }
  }
  return result
}

/**
 * Authoritatively code-sign a built SubEthaEdit.app for Developer ID
 * distribution + notarization. Signs every nested component inside-out with a
 * hardened runtime and secure timestamp, applying per-component entitlements
 * for the three sandboxed pieces (luac, the LSP host XPC service, and the app
 * itself). This deliberately replaces the bundle's existing signatures, so
 * whatever the Xcode build produced (including the legacy resign script) does
 * not matter.
 *
 * @param appPath Path to the built `SubEthaEdit.app`.
 * @param entitlementsDir Directory holding the entitlement plists
 *   (`SubEthaEdit-Mac/` in the checkout).
 */
export async function signSubethaedit(
  appPath: string,
  entitlementsDir: string,
) {
  const appEntitlements = path.join(entitlementsDir, "SubEthaEdit.entitlements")
  const lspEntitlements = path.join(
    entitlementsDir,
    "SubEthaEditLSPHost.entitlements",
  )
  const luacEntitlements = path.join(entitlementsDir, "LuaC.entitlements")

  // 1. Sparkle's nested code first (inside-out): the Autoupdate binary and the
  //    embedded Updater.app, before the framework bundle that contains them.
  for (
    const autoupdate of await expandFiles(
      path.join(
        appPath,
        "Contents/Frameworks/Sparkle.framework/Versions/*/Resources/Autoupdate",
      ),
    )
  ) {
    await codesignDeep(autoupdate)
  }
  for (
    const updater of await expandDirs(
      path.join(
        appPath,
        "Contents/Frameworks/Sparkle.framework/Versions/*/Resources/Updater.app",
      ),
    )
  ) {
    await codesignDeep(updater)
  }

  // 2. All embedded frameworks (Sparkle + the four third-party ones). Frameworks
  //    never carry entitlements.
  for (
    const framework of await expandDirs(
      path.join(appPath, "Contents/Frameworks/*.framework"),
    )
  ) {
    await codesignDeep(framework)
  }

  // 3. Spotlight importer(s).
  for (
    const mdimporter of await expandDirs(
      path.join(appPath, "Contents/Library/Spotlight/*.mdimporter"),
    )
  ) {
    await codesignDeep(mdimporter)
  }

  // 4. The sandboxed luac helper shipped as a loose resource binary in the Lua
  //    mode. Keeps its own entitlements and identifier prefix.
  for (
    const luac of await expandFiles(
      path.join(appPath, "Contents/Resources/Modes/Lua.seemode/**/luac"),
    )
  ) {
    await codesignDeep(luac, {
      entitlements: luacEntitlements,
      prefix: "org.lua.",
    })
  }

  // 5. XPC services. The LSP host is sandboxed and inherits; anything else just
  //    gets a hardened runtime.
  for (
    const xpc of await expandDirs(
      path.join(appPath, "Contents/XPCServices/*.xpc"),
    )
  ) {
    const isLspHost = path.basename(xpc) === "SubEthaEditLSPHost.xpc"
    await codesignDeep(xpc, {
      entitlements: isLspHost ? lspEntitlements : undefined,
    })
  }

  // 6. Re-seal the whole app last with its sandbox entitlements.
  await codesignDeep(appPath, { entitlements: appEntitlements })

  // Fail fast if the bundle isn't internally consistent.
  await builder.exec("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ])
}
