import type { Tool } from "../lib/image.ts"

const REPO = "divvun/cg3-rs"
const RELEASE_TAG = "dev-latest"
const TARGET = "x86_64-unknown-linux-musl"
const PREFIX = "/opt/divvun/bin"

/**
 * Install the Rust cg3 tools from the rolling `dev-latest` release on
 * divvun/cg3-rs: vislcg3, cg-comp, cg-proc, cg-conv, cg-relabel, cg-mwesplit.
 *
 * Deliberately staged in /opt/divvun/bin and **not** added to PATH: the apt
 * `cg3-dev` package installed by the lang pipelines still owns the default
 * tool names. Opt in per-step with `export PATH=/opt/divvun/bin:$PATH`.
 *
 * dev-latest asset names embed a -dev.<timestamp>+build.<n> suffix so we
 * resolve the URL through the GitHub API rather than guessing it. The archive
 * is flat, so everything in it lands in the prefix. The musl build is static,
 * so it also runs on the glibc image.
 */
export function cg3(opts: { prefix?: string } = {}): Tool {
  const prefix = opts.prefix ?? PREFIX

  return {
    name: `cg3 (${RELEASE_TAG}, ${prefix}, off PATH)`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        throw new Error(
          `cg3 tool: only the linux/alpine images are wired up; ` +
            `current platform is "${ctx.platform}"`,
        )
      }

      // grep instead of jq so we don't add a dependency just for this.
      return [
        `RUN set -eu && \\`,
        `    URL=$(curl -fsSL https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG} \\`,
        `          | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]*cg3-${TARGET}-[^"]*\\.tgz"' \\`,
        `          | head -1 \\`,
        `          | sed -E 's/.*"(https:[^"]+)"$/\\1/') && \\`,
        `    test -n "$URL" || { echo 'no cg3-${TARGET} asset on ${RELEASE_TAG}' >&2; exit 1; } && \\`,
        `    curl -fsSL "$URL" -o /tmp/cg3.tgz && \\`,
        `    tar -xf /tmp/cg3.tgz -C /tmp && \\`,
        `    install -d ${prefix} && \\`,
        `    install -m 755 /tmp/cg3-${TARGET}-*/* ${prefix}/ && \\`,
        `    test -x ${prefix}/vislcg3 || { echo 'cg3 archive is missing vislcg3' >&2; exit 1; } && \\`,
        `    rm -rf /tmp/cg3.tgz /tmp/cg3-${TARGET}-*`,
      ].join("\n")
    },
  }
}
