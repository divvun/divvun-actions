import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install Node.js from the official NodeSource deb repo, then enable pnpm
 * via corepack.
 */
export function nodejs(
  opts: { version?: string; enablePnpm?: boolean } = {},
): Tool {
  const version = opts.version ?? versions.nodejs
  const enablePnpm = opts.enablePnpm ?? true
  return {
    name: `nodejs ${version}${enablePnpm ? " + pnpm via corepack" : ""}`,
    render: () => {
      const lines = [
        `curl -fsSL https://deb.nodesource.com/setup_${version} | bash -`,
        `apt-get install -y nodejs`,
      ]
      if (enablePnpm) lines.push(`corepack enable pnpm`)
      lines.push(`rm -rf /var/lib/apt/lists/* && apt-get clean`)
      return `RUN ${lines.join(" && \\\n    ")}`
    },
  }
}
