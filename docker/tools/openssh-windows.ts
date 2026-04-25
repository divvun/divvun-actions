import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install a recent Win32-OpenSSH client. The bundled OpenSSH on
 * windowsservercore-ltsc2022 is too old to negotiate with current
 * SSH servers (kex/host-key issues).
 */
export function opensshWindows(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.openssh
  return {
    name: `Win32-OpenSSH client ${version}`,
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri "https://github.com/PowerShell/Win32-OpenSSH/releases/download/v${version}p2-Preview/OpenSSH-Win64-v${version}.msi" -OutFile openssh.msi ; \\`,
        `    Start-Process -Wait msiexec -ArgumentList '/i', 'openssh.msi', 'ADDLOCAL=Client', '/quiet', '/norestart' ; \\`,
        `    Remove-Item -Force openssh.msi ; \\`,
        `    setx /M PATH $($Env:ProgramFiles + '\\OpenSSH' + ';' + $Env:PATH)`,
      ].join("\n"),
  }
}
