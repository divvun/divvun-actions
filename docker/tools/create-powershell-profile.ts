import type { Tool } from "../lib/image.ts"

/**
 * Ensure $PROFILE exists so any later code that wants to append to it
 * (e.g. shell init for tools) doesn't fail.
 */
export function createPowershellProfile(): Tool {
  return {
    name: "PowerShell profile",
    render: () =>
      [
        `RUN if (!(Test-Path -Path $PROFILE)) { \\`,
        `        New-Item -ItemType File -Path $PROFILE -Force ; \\`,
        `        New-Item -ItemType Directory -Path (Split-Path -Parent $PROFILE) -Force \\`,
        `    }`,
      ].join("\n"),
  }
}
