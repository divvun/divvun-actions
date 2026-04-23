import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

export function rcodesign(
  opts: { version?: string } = {},
): Tool {
  const version = opts.version ?? versions.rcodesign
  return {
    name: `rcodesign@${version}`,
    render: () =>
      [
        `RUN curl -fsSL https://x.giellalt.org/rcodesign-${version}-x86_64-unknown-linux-gnu.tar.gz -o rcodesign.tar.gz && \\`,
        `    bsdtar -xf rcodesign.tar.gz && \\`,
        `    mv rcodesign /usr/local/bin/rcodesign && \\`,
        `    rm rcodesign.tar.gz`,
      ].join("\n"),
  }
}
