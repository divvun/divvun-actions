import type { Tool } from "../lib/image.ts"

export function thfstTools(
  opts: { version?: string } = {},
): Tool {
  const version = opts.version ?? "1.0.0-alpha.2"
  return {
    name: `thfst-tools@${version}`,
    render: () =>
      [
        `RUN curl -fsSL 'https://pahkat.uit.no/artifacts/thfst-tools_${version}_linux_amd64.txz' -o thfst-tools.txz && \\`,
        `    bsdtar -xf thfst-tools.txz -C /usr/local && \\`,
        `    rm thfst-tools.txz`,
      ].join("\n"),
  }
}
