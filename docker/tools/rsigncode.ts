import type { Tool } from "../lib/image.ts"

/**
 * Install rsigncode (Authenticode signing tool) from the divvun/rsigncode
 * dev-latest GitHub release. Replaces chocolatey's stale osslsigncode.
 *
 * dev-latest asset names embed a -dev.<timestamp>+build.<n> suffix so we
 * resolve the URL through the GitHub API rather than guessing it.
 */
export function rsigncode(): Tool {
  return {
    name: "rsigncode (from dev-latest)",
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return [
          `RUN $resp = Invoke-RestMethod 'https://api.github.com/repos/divvun/rsigncode/releases/tags/dev-latest' ; \\`,
          `    $asset = $resp.assets | Where-Object { $_.name -match '^rsigncode-x86_64-pc-windows-msvc-.+\\.zip$' } | Select-Object -First 1 ; \\`,
          `    if (-not $asset) { throw 'no rsigncode-x86_64-pc-windows-msvc asset on dev-latest' } ; \\`,
          `    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile rsigncode.zip ; \\`,
          `    Expand-Archive rsigncode.zip -DestinationPath rsigncode-tmp ; \\`,
          `    Copy-Item rsigncode-tmp\\rsigncode-x86_64-pc-windows-msvc-*\\rsigncode.exe C:\\bin\\rsigncode.exe ; \\`,
          `    Remove-Item -Force rsigncode.zip ; \\`,
          `    Remove-Item -Recurse -Force rsigncode-tmp`,
        ].join("\n")
      }

      // Linux / Alpine (bash). Use grep instead of jq so we don't add a
      // dependency just for this.
      return [
        `RUN set -eu && \\`,
        `    URL=$(curl -fsSL https://api.github.com/repos/divvun/rsigncode/releases/tags/dev-latest \\`,
        `          | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"https://[^"]*rsigncode-x86_64-unknown-linux-gnu-[^"]*\\.tgz"' \\`,
        `          | head -1 \\`,
        `          | sed -E 's/.*"(https:[^"]+)"$/\\1/') && \\`,
        `    test -n "$URL" || { echo 'no rsigncode-x86_64-unknown-linux-gnu asset on dev-latest' >&2; exit 1; } && \\`,
        `    curl -fsSL "$URL" -o /tmp/rsigncode.tgz && \\`,
        `    tar -xf /tmp/rsigncode.tgz -C /tmp && \\`,
        `    install -m 755 /tmp/rsigncode-x86_64-unknown-linux-gnu-*/rsigncode /usr/local/bin/rsigncode && \\`,
        `    rm -rf /tmp/rsigncode.tgz /tmp/rsigncode-x86_64-unknown-linux-gnu-*`,
      ].join("\n")
    },
  }
}
