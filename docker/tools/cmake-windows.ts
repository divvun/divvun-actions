import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install CMake on Windows via the official MSI and add it to system PATH. */
export function cmakeWindows(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.cmake
  return {
    name: `CMake ${version}`,
    render: () =>
      [
        `RUN Invoke-WebRequest -UseBasicParsing 'https://github.com/Kitware/CMake/releases/download/v${version}/cmake-${version}-windows-x86_64.msi' -OutFile cmake.msi ; \\`,
        `    Start-Process -Wait msiexec -ArgumentList '/i', 'cmake.msi', '/quiet', '/norestart' ; \\`,
        `    Remove-Item -Force cmake.msi ; \\`,
        `    $env:PATH = 'C:\\Program Files\\CMake\\bin;' + $env:PATH ; \\`,
        `    [Environment]::SetEnvironmentVariable('PATH', $env:PATH, [EnvironmentVariableTarget]::Machine)`,
      ].join("\n"),
  }
}
