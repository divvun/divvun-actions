import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install `just` on Windows from the prebuilt MSVC zip. */
export function justWindows(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.just
  return {
    name: `just ${version}`,
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri https://github.com/casey/just/releases/download/${version}/just-${version}-x86_64-pc-windows-msvc.zip -OutFile just.zip ; \\`,
        `    Expand-Archive just.zip -DestinationPath .\\just ; \\`,
        `    Move-Item -Path .\\just\\just.exe -Destination C:\\bin\\just.exe ; \\`,
        `    Remove-Item -Force just.zip ; \\`,
        `    Remove-Item -Recurse -Force .\\just`,
      ].join("\n"),
  }
}
