// Build the `oxtreg` registration tool from the divvunspell-libreoffice
// checkout and stage a binary the outto installer can ship next to the .oxt.
//
// oxtreg writes the LibreOffice extension cache directly (no unopkg, no
// LibreOffice tooling), so the install hooks can register the extension from
// the installer context — per-user on macOS, shared (all-users) on Windows.
// See oxtreg/ in divvun/divvunspell-libreoffice.

import * as path from "@std/path"
import * as builder from "~/builder.ts"

// Relative to the repo checkout that is the step's cwd — the same place
// make-oxt-*.{sh,ps1} and src/description.xml live.
const OXTREG_DIR = "oxtreg"

function builtBinary(target: string, exe: boolean): string {
  const name = exe ? "oxtreg.exe" : "oxtreg"
  return path.resolve(OXTREG_DIR, "target", target, "release", name)
}

/**
 * Build a universal (aarch64 + x86_64) macOS oxtreg and lipo it into
 * `outDir/oxtreg`. Mirrors macos/build.sh in the extension repo. Returns the
 * staged binary path.
 */
export async function buildOxtregMacos(outDir: string): Promise<string> {
  const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"]
  const oxtregDir = path.resolve(OXTREG_DIR)
  for (const target of targets) {
    await builder.exec("rustup", ["target", "add", target])
    await builder.exec("cargo", ["build", "--release", "--target", target], {
      cwd: oxtregDir,
    })
  }
  const output = path.join(outDir, "oxtreg")
  await builder.exec("lipo", [
    "-create",
    ...targets.map((t) => builtBinary(t, false)),
    "-output",
    output,
  ])
  await Deno.chmod(output, 0o755)
  return output
}

/**
 * Build oxtreg.exe for `target` (e.g. x86_64-pc-windows-msvc) and copy it to
 * `outDir/oxtreg.exe`. Returns the staged binary path.
 */
export async function buildOxtregWindows(
  target: string,
  outDir: string,
): Promise<string> {
  await builder.exec("rustup", ["target", "add", target])
  await builder.exec("cargo", ["build", "--release", "--target", target], {
    cwd: path.resolve(OXTREG_DIR),
  })
  const output = path.join(outDir, "oxtreg.exe")
  await Deno.copyFile(builtBinary(target, true), output)
  return output
}
