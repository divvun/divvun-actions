import type { Tool } from "../lib/image.ts"

const RELEASE_TAG = "dev-latest"
const REPO = "divvun/outto"

/**
 * Install outto from the rolling `dev-latest` GitHub Release on `divvun/outto`.
 * That release is updated by `pipelineOutto` on every main-branch build —
 * filenames are `outto-<target>-<dev-version>.zip` (Windows) or `.tgz` (macOS),
 * with version a timestamped dev string, so we discover the asset via the
 * GitHub API rather than guessing the URL.
 *
 * The unzipped tree mirrors `runOuttoPublish`'s layout:
 *   outto-<target>-<version>/bin/outto.exe
 *   outto-<target>-<version>/libexec/{outto-gui,outto-sfx,outto-uninstall}.exe
 * which is what outto's `current_exe()/../libexec` lookup expects.
 *
 * Currently only the Windows image is wired up — Linux/Alpine don't invoke
 * outto, and macOS provisioning is outside Docker (Tart).
 */
export function outto(): Tool {
  return {
    name: `outto (${RELEASE_TAG})`,
    render: (ctx) => {
      if (ctx.platform !== "windows") {
        throw new Error(
          `outto tool: only the windows image is wired up; ` +
            `current platform is "${ctx.platform}"`,
        )
      }

      const apiUrl =
        `https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`
      const assetPattern = "^outto-x86_64-pc-windows-msvc-.*\\.zip$"

      return [
        `RUN $rel = Invoke-RestMethod -Uri '${apiUrl}' ; \\`,
        `    $asset = $rel.assets | Where-Object { $_.name -match '${assetPattern}' } | Select-Object -First 1 ; \\`,
        `    if (-not $asset) { throw "No outto windows asset on ${RELEASE_TAG}" } ; \\`,
        `    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile outto.zip ; \\`,
        `    Expand-Archive outto.zip -DestinationPath C:\\outto-extract ; \\`,
        `    $inner = Get-ChildItem C:\\outto-extract -Directory | Select-Object -First 1 ; \\`,
        `    Move-Item $inner.FullName C:\\outto ; \\`,
        `    Remove-Item -Recurse -Force C:\\outto-extract ; \\`,
        `    Remove-Item -Force outto.zip ; \\`,
        `    setx /M PATH $($Env:PATH + ';C:\\outto\\bin')`,
      ].join("\n")
    },
  }
}
