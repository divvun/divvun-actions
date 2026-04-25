import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install PowerShell Core (`pwsh`) via the official MSI. Used in the
 * `windows-vsbase` image where the only shell available is `cmd /S /C`,
 * because subsequent windows images switch SHELL to `pwsh`.
 */
export function powershellCore(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.powershellCore
  return {
    name: `PowerShell Core ${version}`,
    render: () =>
      [
        `RUN powershell -Command "$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri 'https://github.com/PowerShell/PowerShell/releases/download/v${version}/PowerShell-${version}-win-x64.msi' -OutFile 'pwsh.msi'" \``,
        `    && msiexec /i pwsh.msi /quiet /norestart \``,
        `    && del /q pwsh.msi`,
      ].join("\n"),
  }
}
