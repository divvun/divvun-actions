import type { Tool } from "../lib/image.ts"

/**
 * Seed `~/.ssh/known_hosts` at build time.
 *
 * A fresh container has no `~/.ssh` at all, so ssh cannot verify the host key
 * and blocks on the "authenticity of host can't be established" prompt with no
 * tty to answer it — the plugin checkout fails before any pipeline code runs.
 * Because this is per-container state, it broke on every container recreation,
 * which means every image update. Baking the entries into the layer makes them
 * survive recreation. The other platforms do the equivalent at runtime; see the
 * ssh-keyscan in util/shared.ts.
 */
export function knownHosts(opts: { hosts?: string[] } = {}): Tool {
  const hosts = opts.hosts ?? ["github.com"]
  return {
    name: `known_hosts (${hosts.join(", ")})`,
    render: () => {
      const lines = [
        `$sshDir = Join-Path $env:USERPROFILE '.ssh'`,
        `New-Item -ItemType Directory -Force -Path $sshDir | Out-Null`,
        `$knownHosts = Join-Path $sshDir 'known_hosts'`,
        // ssh-keyscan is a native binary, so a failure sets an exit code rather
        // than tripping $ErrorActionPreference. Check the output instead, so a
        // network blip can't bake an empty known_hosts into the image.
        `ssh-keyscan ${
          hosts.join(" ")
        } | Out-File -FilePath $knownHosts -Encoding ascii -Append`,
        ...hosts.map((h) =>
          `if (-not (Select-String -Path $knownHosts -Pattern '${h}' -SimpleMatch -Quiet)) { throw 'ssh-keyscan returned no host key for ${h}' }`
        ),
      ]
      return `RUN ${lines.join(" ; \\\n    ")}`
    },
  }
}
