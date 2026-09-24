import type { Tool } from "../lib/image.ts"
import { assetGlob, assetGrepPattern } from "../../util/asset_name.ts"

const REPO = "divvun/foma-rs"
const RELEASE_TAG = "dev-latest"
const TARGET = "x86_64-unknown-linux-musl"
const PREFIX = "/opt/divvun/bin"
const BINARIES = ["foma", "flookup", "cgflookup"]

/**
 * Bump to pull a newer foma-rs `dev-latest` build into the image.
 *
 * The RUN below is otherwise byte-identical from one generation to the next,
 * so Docker reuses the cached layer even when the upstream build changes.
 * This token is echoed inside the RUN so changing it is a cache miss.
 */
const REFRESH = "2026-09-24"

/**
 * Install foma, flookup and cgflookup from divvun/foma-rs `dev-latest`.
 *
 * Deliberately staged in /opt/divvun/bin and **not** added to PATH: the apt
 * `foma` package installed by the lang pipelines still owns the default tool
 * names. Opt in per-step with `export PATH=/opt/divvun/bin:$PATH`.
 *
 * dev-latest asset names embed a -dev.<timestamp>+build.<n> suffix so we
 * resolve the URL through the GitHub API rather than guessing it. The musl
 * build is static, so it also runs on the glibc image.
 */
export function foma(opts: { prefix?: string } = {}): Tool {
  const prefix = opts.prefix ?? PREFIX
  const installed = BINARIES.map((b) => `/tmp/${assetGlob("foma", TARGET)}/${b}`)

  return {
    name: `foma-rs (${RELEASE_TAG} @ ${REFRESH}, ${prefix}, off PATH)`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        throw new Error(
          `foma tool: only the linux/alpine images are wired up; ` +
            `current platform is "${ctx.platform}"`,
        )
      }

      // grep instead of jq so we don't add a dependency just for this.
      return [
        `RUN set -eu && \\`,
        `    echo 'foma-rs ${RELEASE_TAG} refresh: ${REFRESH}' && \\`,
        `    URL=$(curl -fsSL https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG} \\`,
        `          | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]*${assetGrepPattern("foma", TARGET, "tgz")}"' \\`,
        `          | head -1 \\`,
        `          | sed -E 's/.*"(https:[^"]+)"$/\\1/') && \\`,
        `    test -n "$URL" || { echo 'no foma asset for ${TARGET} on ${RELEASE_TAG}' >&2; exit 1; } && \\`,
        `    echo "installing $URL" && \\`,
        `    curl -fsSL "$URL" -o /tmp/foma.tgz && \\`,
        `    tar -xf /tmp/foma.tgz -C /tmp && \\`,
        `    install -d ${prefix} && \\`,
        `    install -m 755 ${installed.join(" ")} ${prefix}/ && \\`,
        `    rm -rf /tmp/foma.tgz /tmp/${assetGlob("foma", TARGET)}`,
      ].join("\n")
    },
  }
}
