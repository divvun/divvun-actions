import * as builder from "~/builder.ts"

/** Default Developer ID Application identity for Divvun macOS bundles. */
export const APP_CODESIGN_ID =
  "Developer ID Application: The University of Tromso (2K5J2584NX)"

/**
 * Codesign a macOS bundle directory in place with a Developer ID Application
 * identity. Must run before the bundle is packaged (e.g. by outto) so the
 * signature is preserved inside the resulting installer.
 */
export async function codesignBundle(
  bundleDir: string,
  identity: string = APP_CODESIGN_ID,
): Promise<void> {
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
    identity,
    bundleDir,
  ])

  if (result.status.code !== 0) {
    throw new Error(
      `bundle signing failed: ${result.stderr}\nexit code: ${result.status.code}`,
    )
  }
}
