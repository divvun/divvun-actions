import type { Tool } from "../lib/image.ts"
import { assetGlob, assetGrepPattern } from "../../util/asset_name.ts"

const REPO = "divvun/hfst-rs"
const RELEASE_TAG = "dev-latest"
const TARGET = "x86_64-unknown-linux-musl"
const PREFIX = "/opt/divvun/bin"

/**
 * Bump to pull a newer HFST `dev-latest` build into the image.
 *
 * The RUN below is otherwise byte-identical from one generation to the next,
 * so Docker reuses the cached layer even when the upstream build changes.
 * This token is echoed inside the RUN so changing it is a cache miss.
 */
const REFRESH = "2026-09-24"

/**
 * Install Rust hfst from divvun/hfst-rs `dev-latest`.
 *
 * Deliberately staged in /opt/divvun/bin and **not** added to PATH: the apt
 * `hfst` package installed by the lang pipelines still owns the default tool
 * names. Opt in per-step with `export PATH=/opt/divvun/bin:$PATH`.
 *
 * dev-latest asset names embed a -dev.<timestamp>+build.<n> suffix so we
 * resolve the URL through the GitHub API rather than guessing it.
 *
 * hfst is a busybox-style multiplexer dispatching on argv[0], so
 * `install-symlinks` populates the legacy hfst-* names next to the binary.
 * Pointed at its own directory it emits relative symlinks, keeping the tree
 * relocatable. The musl build is static, so it also runs on the glibc image.
 */
export function hfst(opts: { prefix?: string } = {}): Tool {
  const prefix = opts.prefix ?? PREFIX

  return {
    name: `hfst (${RELEASE_TAG} @ ${REFRESH}, ${prefix}, off PATH)`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        throw new Error(
          `hfst tool: only the linux/alpine images are wired up; ` +
            `current platform is "${ctx.platform}"`,
        )
      }

      // grep instead of jq so we don't add a dependency just for this.
      return [
        `RUN set -eu && \\`,
        `    echo 'hfst ${RELEASE_TAG} refresh: ${REFRESH}' && \\`,
        `    URL=$(curl -fsSL https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG} \\`,
        `          | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]*${assetGrepPattern("hfst", TARGET, "tgz")}"' \\`,
        `          | head -1 \\`,
        `          | sed -E 's/.*"(https:[^"]+)"$/\\1/') && \\`,
        `    test -n "$URL" || { echo 'no hfst asset for ${TARGET} on ${RELEASE_TAG}' >&2; exit 1; } && \\`,
        `    echo "installing $URL" && \\`,
        `    curl -fsSL "$URL" -o /tmp/hfst.tgz && \\`,
        `    tar -xf /tmp/hfst.tgz -C /tmp && \\`,
        `    install -d ${prefix} && \\`,
        `    install -m 755 /tmp/${assetGlob("hfst", TARGET)}/hfst ${prefix}/hfst && \\`,
        `    ${prefix}/hfst install-symlinks ${prefix} && \\`,
        `    test -L ${prefix}/hfst-lexc || { echo 'hfst install-symlinks produced no symlinks' >&2; exit 1; } && \\`,
        `    rm -rf /tmp/hfst.tgz /tmp/${assetGlob("hfst", TARGET)}`,
      ].join("\n")
    },
  }
}
