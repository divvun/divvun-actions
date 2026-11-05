import type { Env } from "~/util/env.ts"

const PRERELEASE_IDENTIFIER = String
  .raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`
const SEMVER = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)` +
  String.raw`(?:-${PRERELEASE_IDENTIFIER}(?:\.${PRERELEASE_IDENTIFIER})*)?` +
  String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`

/**
 * Release tags accepted by the central trust boundary.
 *
 * Repositories use either `v1.2.3`, a namespaced tag such as
 * `speller-sme/v1.2.3`, or `kbd-tsf-v1.2.3`. Static-library tags have
 * historically allowed the version with or without the `v` prefix.
 */
export const TRUSTED_RELEASE_TAG = new RegExp(
  String.raw`^(?:v|kbd-tsf-v|[A-Za-z0-9._-]+/v)${SEMVER}$|` +
    String
      .raw`^(?:icu4c|libomp|protobuf|sleef|pytorch|executorch)/(?:v)?${SEMVER}$`,
)

type TrustEnv = Pick<
  Env,
  "branch" | "tag" | "pullRequest" | "repoHost" | "repoPath"
>

export type TrustedReleaseMode = "release" | "dev" | null

const DIVVUN_RELEASE_REPOSITORIES = new Set([
  "msgrammar",
  "divvunspell",
  "divvun-keyboard",
  "divvun-dev-keyboard",
  "kbdgen",
  "kbdi",
  "divvun-runtime",
  "gut",
  "divvun-worker-tts",
  "divvun-speech-py",
  "box",
  "divvun-wind",
  "outto",
  "rsigncode",
  "hfst-rs",
  "foma-rs",
  "cg3-rs",
  "divvun-actions",
  "borealium.org",
  "keyboard-viewer",
  "drb-kicker",
  "teaksta",
  "divvun-worker-grammar",
  "divvun-worker-speller",
  "pahkat",
  "pdf-strings",
  "kielipankki-donatespeech-app",
  "divvunspell-libreoffice",
  "static-lib-build",
])

function isTrustedRepository(owner: string, repoName: string): boolean {
  if (owner === "divvun") return DIVVUN_RELEASE_REPOSITORIES.has(repoName)
  if (owner === "subethaedit") return repoName === "subethaedit"
  if (owner !== "giellalt") return false

  return repoName === "giella-core" ||
    ["lang-", "dict-", "keyboard-", "shared-", "template-"].some(
      (prefix) => repoName.startsWith(prefix),
    )
}

export function isPullRequest(
  env: Pick<Env, "pullRequest">,
): boolean {
  return env.pullRequest != null && env.pullRequest !== "false"
}

export function isTrustedBranch(
  env: Pick<Env, "branch" | "tag" | "pullRequest">,
  branches: readonly string[] = ["main"],
): boolean {
  return !isPullRequest(env) && !env.tag && env.branch != null &&
    branches.includes(env.branch)
}

export function isTrustedTag(
  env: Pick<Env, "tag" | "pullRequest">,
  pattern: RegExp = TRUSTED_RELEASE_TAG,
): boolean {
  if (isPullRequest(env) || !env.tag) return false

  // Avoid stateful behavior if a caller passes a global or sticky expression.
  pattern.lastIndex = 0
  return pattern.test(env.tag)
}

export function trustedReleaseMode(
  env: Pick<Env, "branch" | "tag" | "pullRequest">,
  options: {
    branches?: readonly string[]
    tagPattern?: RegExp
  } = {},
): TrustedReleaseMode {
  if (isTrustedTag(env, options.tagPattern)) return "release"
  if (isTrustedBranch(env, options.branches)) return "dev"
  return null
}

/**
 * The in-process boundary for access to CI credentials and privileged actions.
 * Buildkite secret-access policies remain the authoritative outer boundary.
 */
export function isTrustedReleaseContext(env: TrustEnv): boolean {
  if (env.repoHost !== "github.com" || !env.repoPath.includes("/")) {
    return false
  }

  const [owner, ...nameParts] = env.repoPath.toLowerCase().split("/")
  const repoName = nameParts.at(-1)
  if (!repoName || !isTrustedRepository(owner, repoName)) return false

  const branches = repoName === "kbdgen" || repoName === "kbdi"
    ? ["main", "v4"]
    : ["main"]
  return isTrustedTag(env) || isTrustedBranch(env, branches)
}

export function requireTrustedReleaseContext(
  env: TrustEnv,
  purpose: string,
): void {
  if (!isTrustedReleaseContext(env)) {
    throw new Error(
      `Refusing to ${purpose}: this is not a trusted repository, protected branch, or release-tag build`,
    )
  }
}
