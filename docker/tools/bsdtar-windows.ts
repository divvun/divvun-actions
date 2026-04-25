import type { Tool } from "../lib/image.ts"

/** Install bsdtar.exe for Windows from x.giellalt.org. */
export function bsdtarWindows(): Tool {
  return {
    name: "bsdtar",
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri https://x.giellalt.org/bsdtar.zip -OutFile bsdtar.zip ; \\`,
        `    Expand-Archive bsdtar.zip -DestinationPath C:\\bin ; \\`,
        `    Remove-Item -Force bsdtar.zip`,
      ].join("\n"),
  }
}
