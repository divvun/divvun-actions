// Run a PowerShell script with the MSVC vcvars environment sourced first.
//
// Tools that invoke cl.exe / link.exe (anything in the classic MSVC toolchain)
// need PATH + INCLUDE + LIB + LIBPATH populated. Just prepending the LLVM
// tools dir to PATH — what cargo + clang-cl pipelines get away with — is not
// enough. The Windows build image ships an `msvc-env.exe` helper (installed
// by docker/tools/msvc-env.ts) that emits PowerShell `$env:KEY = "VAL"`
// statements for whichever target arch you ask for; piping into
// `Invoke-Expression` imports them into the current session, and any child
// process inherits them.

import * as builder from "~/builder.ts"

export type MsvcArch = "x64" | "arm64"

/** Map a Rust target triple to the arch arg msvc-env.exe expects. */
export function msvcArchFor(triple: string): MsvcArch {
  return triple.includes("aarch64") ? "arm64" : "x64"
}

/**
 * Invoke `pwsh` with `msvc-env <arch>` sourced into the session before
 * running `scriptPath`. `options.env` / `options.cwd` are threaded through.
 */
export async function execWithMsvcEnv(
  arch: MsvcArch,
  scriptPath: string,
  options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<void> {
  const inline = `msvc-env ${arch} | Invoke-Expression; & "${scriptPath}"`
  await builder.exec("pwsh", ["-NoProfile", "-Command", inline], {
    env: options.env,
    cwd: options.cwd,
  })
}
