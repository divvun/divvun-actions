import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install Node.js on Windows via choco and enable pnpm via corepack. */
export function nodejsWindows(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.nodeChocoVersion
  return {
    name: `Node.js ${version} + pnpm via corepack`,
    render: () =>
      [
        `RUN choco install nodejs --version="${version}" -y ; \\`,
        `    setx /M PATH $($Env:PATH + ';C:\\Program Files\\nodejs')`,
        `RUN corepack enable pnpm`,
      ].join("\n"),
  }
}
