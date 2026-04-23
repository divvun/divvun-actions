import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install the GitHub CLI.
 *
 * - ubuntu: .deb package
 * - alpine: tarball (no deb support)
 * - windows: zip
 */
export function gh(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.gh
  return {
    name: `gh@${version}`,
    render: (ctx) => {
      if (ctx.platform === "ubuntu") {
        return [
          `RUN curl -fsSL https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_amd64.deb -o gh.deb && \\`,
          `    dpkg -i gh.deb && \\`,
          `    rm gh.deb && \\`,
          `    rm -rf /var/lib/apt/lists/* && apt-get clean`,
        ].join("\n")
      }
      if (ctx.platform === "alpine") {
        return [
          `RUN curl -fsSL https://github.com/cli/cli/releases/download/v${version}/gh_${version}_linux_amd64.tar.gz -o gh.tar.gz && \\`,
          `    bsdtar -xzf gh.tar.gz && \\`,
          `    mv gh_${version}_linux_amd64/bin/gh /usr/local/bin/gh && \\`,
          `    rm -rf gh.tar.gz gh_${version}_linux_amd64`,
        ].join("\n")
      }
      // windows
      return [
        `RUN Invoke-WebRequest -Uri "https://github.com/cli/cli/releases/download/v${version}/gh_${version}_windows_amd64.zip" -OutFile gh.zip ; \\`,
        `    Expand-Archive gh.zip -DestinationPath C:\\ ; \\`,
        `    Remove-Item -Force gh.zip`,
      ].join("\n")
    },
  }
}
