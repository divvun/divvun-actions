// kbdi never reaches pahkat from Buildkite. Pushes to its `main` branch
// publish kbdi to the KBDI_DEV_TAG prerelease, and pushes to its `v4` branch
// to the KBDI_V4_TAG prerelease, which the kbdgen v4 keyboard builds download
// (actions/keyboard/build/toolchain.ts).

import * as builder from "~/builder.ts"

export const KBDI_REPO = "divvun/kbdi"
export const KBDI_DEV_BRANCH = "main"
/** The rolling prerelease of KBDI_REPO that each KBDI_DEV_BRANCH build replaces. */
export const KBDI_DEV_TAG = "dev-latest"
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

/** A rolling prerelease of KBDI_REPO that a branch's builds replace. */
export type KbdiPrerelease = {
  tag: string
  /** The release title for a build of `version`. */
  name: (version: string) => string
  /**
   * Whether the version carries `+build.<n>`. v4-latest's names never have,
   * and dev-latest's do, as the other tools' dev-latest releases' do.
   */
  buildNumber: boolean
}

/**
 * The prerelease this build replaces: KBDI_DEV_TAG for a push to
 * KBDI_DEV_BRANCH and KBDI_V4_TAG for one to KBDI_V4_BRANCH, outside a pull
 * request and a tag.
 */
export function kbdiPrerelease(): KbdiPrerelease | null {
  if (builder.env.pullRequest && builder.env.pullRequest !== "false") {
    return null
  }
  if (builder.env.tag) {
    return null
  }
  switch (builder.env.branch) {
    case KBDI_DEV_BRANCH:
      return {
        tag: KBDI_DEV_TAG,
        name: (version) => `v${version}`,
        buildNumber: true,
      }
    case KBDI_V4_BRANCH:
      return {
        tag: KBDI_V4_TAG,
        name: (version) => `kbdi v4 ${version}`,
        buildNumber: false,
      }
    default:
      return null
  }
}
