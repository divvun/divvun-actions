import type { Tool } from "../lib/image.ts"

/**
 * Seed the machine-wide `known_hosts` at build time.
 *
 * A fresh container or microVM has no `~/.ssh` at all. The agent adds a host
 * key only when it clones something new, so once the divvun-actions plugin is
 * already checked out, its environment hook's `git fetch` over ssh is the
 * first thing to meet github.com, and it waits at the "authenticity of host
 * can't be established" prompt for an answer that never comes. On Docker
 * builders this broke on every container recreation, which means every image
 * update; on microVMs, which start every job from the image, it hangs every
 * job whose plugin checkout is cached. Baking the entries into the layer fixes
 * both.
 *
 * Written to ssh's default GlobalKnownHostsFile rather than a user's
 * `known_hosts`: `%ProgramData%\ssh\ssh_known_hosts` on Windows, where the
 * buildkite agent runs in the Services session and cannot be relied on to
 * resolve `$env:USERPROFILE` to the same place an interactive logon does (see
 * [sshIdentity] for the same problem affecting the key itself), and
 * `/etc/ssh/ssh_known_hosts` elsewhere.
 */
export function knownHosts(opts: { hosts?: string[] } = {}): Tool {
  const hosts = opts.hosts ?? ["github.com"]
  return {
    name: `known_hosts (${hosts.join(", ")})`,
    render: (ctx) => {
      if (ctx.platform !== "windows") {
        // Check that every host made it in: a network blip must not bake an
        // empty file.
        const lines = [
          "mkdir -p /etc/ssh",
          `ssh-keyscan ${hosts.join(" ")} >> /etc/ssh/ssh_known_hosts`,
          ...hosts.map((h) => `grep -q '^${h} ' /etc/ssh/ssh_known_hosts`),
        ]
        return `RUN ${lines.join(" && \\\n    ")}`
      }
      const lines = [
        `$sshDir = Join-Path $env:ProgramData 'ssh'`,
        `New-Item -ItemType Directory -Force -Path $sshDir | Out-Null`,
        `$knownHosts = Join-Path $sshDir 'ssh_known_hosts'`,
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
