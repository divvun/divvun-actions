import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install Git for Windows silently, add it to PATH, and enable long-path
 * support globally.
 */
export function gitForWindows(
  opts: { version?: string } = {},
): Tool {
  const version = opts.version ?? versions.gitForWindows
  return {
    name: `Git for Windows ${version}`,
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri https://github.com/git-for-windows/git/releases/download/v${version}.windows.1/Git-${version}-64-bit.exe -OutFile git-installer.exe ; \\`,
        `    Start-Process -FilePath git-installer.exe -ArgumentList '/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS="bash,bash_path"' -Wait ; \\`,
        `    Remove-Item git-installer.exe`,
        ``,
        `# Add Git to PATH`,
        `RUN setx /M PATH $($Env:PATH + 'C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;');`,
        ``,
        `# Configure Git for long paths`,
        `RUN git config --global core.longpaths true`,
      ].join("\n"),
  }
}
