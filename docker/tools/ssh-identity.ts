import type { Tool } from "../lib/image.ts"

/**
 * Point ssh at the buildkite deploy key mounted by `update.ps1`, via the
 * machine-wide client config.
 *
 * The key was previously reachable only through ssh-agent, which on Windows
 * stores identities in `HKCU\Software\OpenSSH\Agent\Keys` encrypted per user.
 * An interactive logon has that hive loaded, but the agent process runs in the
 * Services session where HKCU can resolve to `.DEFAULT` — so `ssh-add -l`
 * listed the key when you shelled in, while buildkite's own `git clone` was
 * offered no identity at all and failed with `Permission denied (publickey)`.
 *
 * `%ProgramData%\ssh\ssh_config` is read by both the inbox client and the one
 * in `C:\Program Files\OpenSSH`, in any session, with no profile or registry
 * dependency. Only the path is baked into the image; the key itself arrives at
 * runtime on the `C:\buildkite-secrets` volume.
 *
 * `IdentitiesOnly` is deliberately not set, so a working ssh-agent still acts
 * as a fallback if the mounted key is unreadable.
 */
export function sshIdentity(opts: {
  host?: string
  identityFile?: string
} = {}): Tool {
  const host = opts.host ?? "github.com"
  const identityFile = opts.identityFile ??
    "C:\\buildkite-secrets\\id_ed25519_buildkite_git"
  return {
    name: `ssh identity for ${host}`,
    render: () => {
      const entries = [
        `Host ${host}`,
        `    IdentityFile ${identityFile}`,
        `    StrictHostKeyChecking accept-new`,
      ].map((l) => `'${l}'`).join(", ")
      const lines = [
        `$sshDir = Join-Path $env:ProgramData 'ssh'`,
        `New-Item -ItemType Directory -Force -Path $sshDir | Out-Null`,
        `Set-Content -Path (Join-Path $sshDir 'ssh_config') -Value @(${entries}) -Encoding ascii`,
      ]
      return `RUN ${lines.join(" ; \\\n    ")}`
    },
  }
}
