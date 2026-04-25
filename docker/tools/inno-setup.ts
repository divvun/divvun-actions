import type { Tool } from "../lib/image.ts"

/** Install Inno Setup 6 silently. */
export function innoSetup(): Tool {
  return {
    name: "Inno Setup",
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri https://jrsoftware.org/download.php/is.exe?site=2 -OutFile innosetup.exe; \\`,
        `    Start-Process -FilePath .\\innosetup.exe -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' -Wait; \\`,
        `    Remove-Item innosetup.exe; \\`,
        `    setx /M PATH $($Env:PATH + ';C:\\Program Files (x86)\\Inno Setup 6');`,
      ].join("\n"),
  }
}
