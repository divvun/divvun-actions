import type { Tool } from "../lib/image.ts"

/**
 * Install Microsoft Keyboard Layout Creator. The download is a
 * self-extracting archive; we extract with `tar` and then run the inner
 * msi unattended.
 */
export function msklc(): Tool {
  return {
    name: "MSKLC",
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri https://download.microsoft.com/download/6/f/5/6f5ce43a-e892-4fd1-b9a6-1a0cbb64e6e2/MSKLC.exe -OutFile MSKLC.exe ; \\`,
        `    Start-Process -FilePath tar -ArgumentList '-xf .\\MSKLC.exe' -Wait ; \\`,
        `    Start-Process -FilePath msiexec.exe -ArgumentList '/i .\\MSKLC\\msklc.msi /qn /norestart' -Wait ; \\`,
        `    Remove-Item MSKLC.exe`,
      ].join("\n"),
  }
}
