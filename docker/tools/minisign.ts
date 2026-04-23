import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

export function minisign(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.minisign
  return {
    name: `minisign@${version}`,
    render: () =>
      [
        `RUN curl -fsSL "https://github.com/jedisct1/minisign/releases/download/${version}/minisign-${version}-linux.tar.gz" -o "minisign.tar.gz" && \\`,
        `    tar -xzf minisign.tar.gz && \\`,
        `    mv minisign-linux/x86_64/minisign /usr/local/bin/minisign && \\`,
        `    rm -rf minisign.tar.gz minisign-linux`,
      ].join("\n"),
  }
}
