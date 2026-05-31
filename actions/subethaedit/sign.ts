import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"

/** Empty entitlements, applied to components that must not inherit the app sandbox. */
const EMPTY_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
`

/** Bundle-relative path of the sandboxed LSP host XPC service. */
const LSP_HOST = "Contents/XPCServices/SubEthaEditLSPHost.xpc"
/** Bundle-relative path of the sandboxed luac helper shipped in the Lua mode. */
const LUAC =
  "Contents/Resources/Modes/Lua.seemode/Contents/Resources/Scripts/shell/luac"
/** Bundle-relative path of Sparkle, whose updater must not run sandboxed. */
const SPARKLE = "Contents/Frameworks/Sparkle.framework"

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Authoritatively code-sign a built SubEthaEdit.app for Developer ID
 * distribution + notarization, using rcodesign with the Developer ID cert from
 * the vault (`macos/appPem`). This is the divvun signing path — there is no
 * Developer ID identity in the build agents' keychain.
 *
 * `--for-notarization` enables the hardened runtime + a secure timestamp on
 * every Mach-O. Entitlements are applied per component via rcodesign's scoped
 * settings: the app (and anything not scoped) gets the sandbox entitlements,
 * the two sandboxed helpers keep their own narrower ones, and Sparkle is signed
 * without the sandbox so its updater still works. This replaces the bundle's
 * existing signatures, so whatever the Xcode build produced does not matter.
 *
 * @param appPath Path to the built `SubEthaEdit.app`.
 * @param entitlementsDir Directory holding the entitlement plists
 *   (`SubEthaEdit-Mac/` in the checkout).
 */
export async function signSubethaedit(
  appPath: string,
  entitlementsDir: string,
) {
  using tempDir = await makeTempDir({ prefix: "subethaedit-sign-" })

  const pemFile = path.join(tempDir.path, "devid.pem")
  const emptyEntitlements = path.join(tempDir.path, "empty.entitlements")

  const secrets = await builder.secrets()
  await Deno.writeTextFile(pemFile, secrets.get("macos/appPem"))
  await Deno.writeTextFile(emptyEntitlements, EMPTY_ENTITLEMENTS)

  const appEntitlements = path.resolve(
    entitlementsDir,
    "SubEthaEdit.entitlements",
  )
  const lspEntitlements = path.resolve(
    entitlementsDir,
    "SubEthaEditLSPHost.entitlements",
  )
  const luacEntitlements = path.resolve(entitlementsDir, "LuaC.entitlements")

  // The app (and, by default, anything not scoped below) gets the sandbox.
  const args = [
    "sign",
    "--pem-file",
    pemFile,
    "--for-notarization",
    "-e",
    appEntitlements,
  ]

  // Scoped overrides, but only for components that actually exist in the build
  // (an App Store cleanup phase may strip some), so rcodesign doesn't error on
  // a missing path.
  const scopes: Array<[string, string]> = [
    [LSP_HOST, lspEntitlements],
    [LUAC, luacEntitlements],
    [SPARKLE, emptyEntitlements],
  ]
  for (const [relPath, entitlements] of scopes) {
    if (await exists(path.join(appPath, relPath))) {
      args.push("-e", `${relPath}:${entitlements}`)
    } else {
      logger.warning(`Skipping signing scope (not found in bundle): ${relPath}`)
    }
  }

  args.push(appPath)

  logger.info(`Signing ${appPath} with rcodesign (Developer ID, notarization)`)
  await builder.exec("rcodesign", args)

  const info = await builder.output("rcodesign", [
    "print-signature-info",
    appPath,
  ])
  logger.info("rcodesign print-signature-info:", info.stdout)
}
