import type { Tool } from "../lib/image.ts"

const REPO = "divvun/hfst-rs"
const RELEASE_TAG = "dev-latest"
const TARGET = "x86_64-unknown-linux-musl"
const PREFIX = "/opt/divvun/bin"

/**
 * Bump to pull a newer `dev-latest` build into the image.
 *
 * The RUN below is otherwise byte-identical from one generation to the next,
 * so Docker reuses the cached layer forever and the image keeps whichever
 * binary it happened to fetch first, no matter how far `dev-latest` has moved.
 * This token is echoed inside the RUN so changing it is a cache miss.
 */
const REFRESH = "2026-08-27"

/**
 * Install the Rust hfst from the rolling `dev-latest` release on divvun/hfst-rs.
 *
 * Deliberately staged in /opt/divvun/bin and **not** added to PATH: the apt
 * `hfst` packages installed by the lang pipelines still own the default tool
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
        `          | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]*hfst-${TARGET}-[^"]*\\.tgz"' \\`,
        `          | head -1 \\`,
        `          | sed -E 's/.*"(https:[^"]+)"$/\\1/') && \\`,
        `    test -n "$URL" || { echo 'no hfst-${TARGET} asset on ${RELEASE_TAG}' >&2; exit 1; } && \\`,
        `    echo "installing $URL" && \\`,
        `    curl -fsSL "$URL" -o /tmp/hfst.tgz && \\`,
        `    tar -xf /tmp/hfst.tgz -C /tmp && \\`,
        `    install -d ${prefix} && \\`,
        `    install -m 755 /tmp/hfst-${TARGET}-*/hfst ${prefix}/hfst && \\`,
        `    ${prefix}/hfst install-symlinks ${prefix} && \\`,
        `    test -L ${prefix}/hfst-lexc || { echo 'hfst install-symlinks produced no symlinks' >&2; exit 1; } && \\`,
        `    rm -rf /tmp/hfst.tgz /tmp/hfst-${TARGET}-*`,
      ].join("\n")
    },
  }
}
