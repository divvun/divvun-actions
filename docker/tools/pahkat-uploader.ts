import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install pahkat-uploader from pahkat.uit.no devtools channel. */
export function pahkatUploader(
  opts: { channel?: string } = {},
): Tool {
  const channel = opts.channel ?? versions.pahkatDevtoolsChannel
  return {
    name: `pahkat-uploader (${channel})`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return [
          `RUN Invoke-WebRequest -Uri 'https://pahkat.uit.no/devtools/download/pahkat-uploader?platform=windows&channel=${channel}' -OutFile pahkat-uploader.txz ; \\`,
          `    Start-Process -FilePath bsdtar.exe -ArgumentList '-xf .\\pahkat-uploader.txz -C C:\\' -Wait ; \\`,
          `    Remove-Item -Force pahkat-uploader.txz`,
        ].join("\n")
      }
      return [
        `RUN curl -fsSL 'https://pahkat.uit.no/devtools/download/pahkat-uploader?platform=linux&channel=${channel}' -o pahkat-uploader.txz && \\`,
        `    bsdtar -xf pahkat-uploader.txz -C /usr/local && \\`,
        `    rm pahkat-uploader.txz`,
      ].join("\n")
    },
  }
}
