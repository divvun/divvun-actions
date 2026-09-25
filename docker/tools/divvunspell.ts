import type { Tool } from "../lib/image.ts"
import { assetGlob, assetGrepPattern } from "../../util/asset_name.ts"

const REPO = "divvun/divvunspell"
const RELEASE_TAG = "dev-latest"
const TARGET = "x86_64-unknown-linux-gnu"

/** Bump to pull a newer `dev-latest` build into the image. */
const REFRESH = "2026-09-25"

/**
 * Install the `divvunspell` CLI from divvun/divvunspell `dev-latest`.
 *
 * Unlike the Rust hfst/cg3 (staged in /opt/divvun/bin, off PATH, so the apt
 * tools keep the default names), nothing else ships a `divvunspell` binary and
 * giella-core's `AC_PATH_PROG([DIVVUNSPELL], [divvunspell])` searches `$PATH` —
 * so this goes straight into /usr/local/bin.
 *
 * Needed by the lang docs-publish step, which runs `divvunspell accuracy` to
 * regenerate `docs/typosreport/report.json` and
 * `docs/badgedata/speller-suggestions.json`. Without it `configure` silently
 * sets `DIVVUNSPELL=false` and that make target fails.
 *
 * dev-latest asset names embed a -dev.<timestamp>+build.<n> suffix, so the URL
 * is resolved through the GitHub API. The Linux CLI only ships glibc builds,
 * which is what the `ubuntu` image uses; `alpine` (musl) is not wired up.
 */
export function divvunspell(): Tool {
  return {
    name: `divvunspell (${RELEASE_TAG} @ ${REFRESH})`,
    render: (ctx) => {
      if (ctx.platform !== "ubuntu") {
        throw new Error(
          `divvunspell tool: only the ubuntu image is wired up ` +
            `(glibc-only release); current platform is "${ctx.platform}"`,
        )
      }
      return [
        `RUN set -eu && \\`,
        `    echo 'divvunspell ${RELEASE_TAG} refresh: ${REFRESH}' && \\`,
        `    URL=$(curl -fsSL https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG} \\`,
        `          | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]*${
          assetGrepPattern("divvunspell", TARGET, "tgz")
        }"' \\`,
        `          | head -1 \\`,
        `          | sed -E 's/.*"(https:[^"]+)"$/\\1/') && \\`,
        `    test -n "$URL" || { echo 'no divvunspell asset for ${TARGET} on ${RELEASE_TAG}' >&2; exit 1; } && \\`,
        `    echo "installing $URL" && \\`,
        `    curl -fsSL "$URL" -o /tmp/divvunspell.tgz && \\`,
        `    tar -xf /tmp/divvunspell.tgz -C /tmp && \\`,
        `    install -m 755 /tmp/${
          assetGlob("divvunspell", TARGET)
        }/divvunspell /usr/local/bin/divvunspell && \\`,
        `    rm -rf /tmp/divvunspell.tgz /tmp/${
          assetGlob("divvunspell", TARGET)
        } && \\`,
        `    divvunspell --version`,
      ].join("\n")
    },
  }
}
