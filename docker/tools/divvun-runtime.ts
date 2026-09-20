import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

export function divvunRuntime(
  opts: { version?: string } = {},
): Tool {
  const version = opts.version ?? versions.divvunRuntime
  return {
    name: `divvun-runtime@${version}`,
    render: () =>
      [
        `RUN curl -fsSL "https://github.com/divvun/divvun-runtime/releases/download/v${version}/divvun-runtime-x86_64-unknown-linux-musl-v${version}.tgz" -o "divvun-runtime.tgz" && \\`,
        `    bsdtar -xf divvun-runtime.tgz && \\`,
        `    cp divvun-runtime-x86_64*/divvun-runtime /usr/local/bin/divvun-runtime && \\`,
        `    rm -rf divvun-runtime.tgz divvun-runtime-x86_64*`,
      ].join("\n"),
  }
}
