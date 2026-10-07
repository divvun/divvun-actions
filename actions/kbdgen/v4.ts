// kbdgen's `v4` branch never reaches pahkat. Its builds publish kbdgen and
// the text service installer to the KBDGEN_V4_TAG prerelease, which the
// "kbdgen v4 (test)" group of a format 4 keyboard's pipeline builds from.

import * as builder from "~/builder.ts"

export const KBDGEN_REPO = "divvun/kbdgen"
export const KBDGEN_V4_BRANCH = "v4"
/** The rolling prerelease of KBDGEN_REPO that each v4 build replaces. */
export const KBDGEN_V4_TAG = "v4-latest"
export const KBDGEN_NAME = "kbdgen"
/** The kbdgen that Windows keyboard builds run. */
export const KBDGEN_WINDOWS_TARGET = "x86_64-pc-windows-msvc"

/** A push to KBDGEN_V4_BRANCH, outside a pull request and a tag. */
export function isKbdgenV4Build(): boolean {
  if (builder.env.pullRequest && builder.env.pullRequest !== "false") {
    return false
  }
  return !builder.env.tag && builder.env.branch === KBDGEN_V4_BRANCH
}
