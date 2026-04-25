import type { Tool } from "../lib/image.ts"

/** Install the static Docker CLI on Windows. */
export function dockerCliWindows(
  opts: { version?: string } = {},
): Tool {
  const version = opts.version ?? "28.3.2"
  return {
    name: `Docker CLI ${version}`,
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri "https://download.docker.com/win/static/stable/x86_64/docker-${version}.zip" -OutFile docker.zip ; \\`,
        `    Expand-Archive docker.zip -DestinationPath $Env:ProgramFiles ; \\`,
        `    Remove-Item -Force docker.zip ; \\`,
        `    setx /M PATH $($Env:PATH + ';' + $Env:ProgramFiles + '\\Docker')`,
      ].join("\n"),
  }
}
