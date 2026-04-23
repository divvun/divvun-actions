import type { Tool } from "../lib/image.ts"

export type AptRepoOpts = {
  /** Human label, used in the comment above the RUN. */
  name: string
  /** URL of the GPG key (armored or binary). Will be dearmored into `keyring`. */
  keyUrl: string
  /** Absolute path to write the dearmored keyring file. */
  keyring: string
  /** Full deb source line — will be written verbatim to /etc/apt/sources.list.d/<list>. */
  sourceLine: string
  /** Name of the .list file under /etc/apt/sources.list.d/. */
  list: string
  /** Run `apt-get update` after adding the repo (default false). */
  update?: boolean
}

/**
 * Adds a signed third-party apt repository: fetches the key, dearmors it,
 * and writes the sources.list.d entry. Does NOT install any package —
 * caller should add the desired packages to `aptPackages` or a subsequent tool.
 */
export function aptRepo(opts: AptRepoOpts): Tool {
  return {
    name: `apt repo: ${opts.name}`,
    render: () => {
      const lines = [
        `curl -fsSL ${opts.keyUrl} | gpg --dearmor -o ${opts.keyring}`,
        `echo "${opts.sourceLine}" > /etc/apt/sources.list.d/${opts.list}`,
      ]
      if (opts.update) lines.push(`apt-get update`)
      return `RUN ${lines.join(" && \\\n    ")}`
    },
  }
}
