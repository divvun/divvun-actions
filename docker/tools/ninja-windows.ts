import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install Ninja on Windows by extracting the prebuilt zip into C:\bin. */
export function ninjaWindows(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.ninja
  return {
    name: `Ninja ${version}`,
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri 'https://github.com/ninja-build/ninja/releases/download/v${version}/ninja-win.zip' -OutFile ninja.zip ; \\`,
        `    Expand-Archive ninja.zip -DestinationPath C:\\bin ; \\`,
        `    Remove-Item -Force ninja.zip`,
      ].join("\n"),
  }
}
