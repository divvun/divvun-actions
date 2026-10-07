// kbdi's `v4` branch never reaches pahkat. Its builds publish kbdi to the
// KBDI_V4_TAG prerelease, which the kbdgen v4 keyboard builds download
// (actions/keyboard/build/toolchain.ts). Production kbdi is released to
// pahkat's devtools by the Taskcluster tasks kbdi's .taskcluster.yml runs.

import * as builder from "~/builder.ts"

export const KBDI_REPO = "divvun/kbdi"
export const KBDI_V4_BRANCH = "v4"
/** The rolling prerelease of KBDI_REPO that each v4 build replaces. */
export const KBDI_V4_TAG = "v4-latest"
export const KBDI_NAME = "kbdi"

/**
 * The kbdi builds, by Rust target, with the name a keyboard installer's
 * payload gives each. kbdi.exe runs on x86 Windows and kbdi-x64.exe in 64-bit
 * install mode; the keyboard installers ship only those two
 * (`keyboardPayload`).
 */
export const KBDI_BUILDS = [
  {
    target: "i686-pc-windows-msvc",
    payload: "kbdi.exe",
    keyboardPayload: true,
  },
  {
    target: "x86_64-pc-windows-msvc",
    payload: "kbdi-x64.exe",
    keyboardPayload: true,
  },
  {
    target: "aarch64-pc-windows-msvc",
    payload: "kbdi-arm64.exe",
    keyboardPayload: false,
  },
] as const

/** A push to KBDI_V4_BRANCH, outside a pull request and a tag. */
export function isKbdiV4Build(): boolean {
  if (builder.env.pullRequest && builder.env.pullRequest !== "false") {
    return false
  }
  return !builder.env.tag && builder.env.branch === KBDI_V4_BRANCH
}
