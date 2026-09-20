import type { Tool } from "../lib/image.ts"
import { assetGlob, assetGrepPattern } from "../../util/asset_name.ts"

const REPO = "divvun/divvun-runtime"
const RELEASE_TAG = "dev-latest"
const TARGET = "x86_64-unknown-linux-gnu"

/** Bump to pull a newer `dev-latest` build into the image. */
const REFRESH = "2026-09-17"

/**
 * Install the `divvun-runtime` CLI from divvun/divvun-runtime `dev-latest`.
 *
 * Follows the rolling tag rather than a pinned release, as the hfst tool does.
 * The pin it replaces sat at v0.3.1 (2025-12) long enough to matter: the lang
 * grammar-checker pipelines import their speller config from a file beside
 * them, and a divvun-runtime older than "run pipelines in place" copies the
 * pipeline's source text into a temp directory before executing it, so every
 * such import dangles at bundle time while `deno check` — run against the real
 * file — passes.
 *
 * dev-latest asset names embed a -dev.<timestamp>+build.<n> suffix, so the URL
 * is resolved through the GitHub API rather than guessed. glibc, not musl:
 * this is the ubuntu image, and the musl CLI is not currently built
 * (MUSL_ENABLED is false in the release pipeline).
 */
export function divvunRuntime(): Tool {
  return {
    name: `divvun-runtime (${RELEASE_TAG} @ ${REFRESH})`,
    render: (ctx) => {
      if (ctx.platform !== "ubuntu") {
        throw new Error(
          `divvun-runtime tool: only the ubuntu image is wired up ` +
            `(glibc target); current platform is "${ctx.platform}"`,
        )
      }

      // grep instead of jq so we don't add a dependency just for this.
      return [
        `RUN set -eu && \\`,
        `    echo 'divvun-runtime ${RELEASE_TAG} refresh: ${REFRESH}' && \\`,
        `    URL=$(curl -fsSL https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG} \\`,
        `          | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]*${
          assetGrepPattern("divvun-runtime", TARGET, "tgz")
        }"' \\`,
        `          | head -1 \\`,
        `          | sed -E 's/.*"(https:[^"]+)"$/\\1/') && \\`,
        `    test -n "$URL" || { echo 'no divvun-runtime asset for ${TARGET} on ${RELEASE_TAG}' >&2; exit 1; } && \\`,
        `    echo "installing $URL" && \\`,
        `    curl -fsSL "$URL" -o /tmp/divvun-runtime.tgz && \\`,
        `    tar -xf /tmp/divvun-runtime.tgz -C /tmp && \\`,
        `    install -m 755 /tmp/${
          assetGlob("divvun-runtime", TARGET)
        }/divvun-runtime /usr/local/bin/divvun-runtime && \\`,
        `    rm -rf /tmp/divvun-runtime.tgz /tmp/${
          assetGlob("divvun-runtime", TARGET)
        } && \\`,
        `    divvun-runtime --version`,
      ].join("\n")
    },
  }
}
