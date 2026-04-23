import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install kbdgen from pahkat devtools. */
export function kbdgen(opts: { channel?: string } = {}): Tool {
  const channel = opts.channel ?? versions.pahkatDevtoolsChannel
  return {
    name: `kbdgen (${channel})`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return [
          `RUN Invoke-WebRequest -Uri https://x.giellalt.org/kbdgen.zip -OutFile kbdgen.zip ; \\`,
          `    Expand-Archive kbdgen.zip -DestinationPath C:\\bin ; \\`,
          `    Remove-Item -Force kbdgen.zip`,
        ].join("\n")
      }
      return [
        `RUN curl -fsSL 'https://pahkat.uit.no/devtools/download/kbdgen?platform=linux&channel=${channel}' -o kbdgen.txz && \\`,
        `    bsdtar -xf kbdgen.txz -C /usr/local && \\`,
        `    rm kbdgen.txz`,
      ].join("\n")
    },
  }
}
