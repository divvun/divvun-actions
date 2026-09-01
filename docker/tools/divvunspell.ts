import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

const REPO = "divvun/divvunspell"
const TARGET = "x86_64-unknown-linux-gnu"

/**
 * Install the `divvunspell` CLI from a pinned release on divvun/divvunspell.
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
 * The release only ships the glibc target, which is what the `ubuntu` image
 * uses; `alpine` (musl) is not wired up, and never runs docs-publish anyway.
 */
export function divvunspell(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.divvunspell
  const dir = `divvunspell-${TARGET}-v${version}`
  const url =
    `https://github.com/${REPO}/releases/download/divvunspell/v${version}/${dir}.tgz`

  return {
    name: `divvunspell@${version}`,
    render: (ctx) => {
      if (ctx.platform !== "ubuntu") {
        throw new Error(
          `divvunspell tool: only the ubuntu image is wired up ` +
            `(glibc-only release); current platform is "${ctx.platform}"`,
        )
      }
      return [
        `RUN curl -fsSL "${url}" -o divvunspell.tgz && \\`,
        `    tar -xf divvunspell.tgz && \\`,
        `    install -m 755 ${dir}/divvunspell /usr/local/bin/divvunspell && \\`,
        `    rm -rf divvunspell.tgz ${dir} && \\`,
        `    divvunspell --version`,
      ].join("\n")
    },
  }
}
