import type { Tool } from "../lib/image.ts"
import { assetPsPattern } from "../../util/asset_name.ts"

const RELEASE_TAG = "dev-latest"
const REPO = "divvun/outto"

/**
 * Bump to pull a newer `dev-latest` build into the image. The RUN below never
 * changes on its own, so Docker reuses the cached layer and keeps whichever
 * outto it fetched first. This token is echoed inside the RUN, so changing it
 * is a cache miss.
 */
const REFRESH = "2026-10-07"

/**
 * Install outto from the rolling `dev-latest` GitHub Release on `divvun/outto`.
 * That release is updated by `pipelineOutto` on every main-branch build —
 * filenames are `outto_<target>_<dev-version>.zip` (Windows) or `.tgz` (macOS),
 * with version a timestamped dev string, so we discover the asset via the
 * GitHub API rather than guessing the URL.
 *
 * The unzipped tree mirrors `runOuttoPublish`'s layout:
 *   outto_<target>_<version>/bin/outto.exe
 *   outto_<target>_<version>/libexec/{outto-gui,outto-sfx,outto-uninstall}.exe
 * which is what outto's `current_exe()/../libexec` lookup expects.
 *
 * Currently only the Windows image is wired up — Linux/Alpine don't invoke
 * outto, and macOS provisioning is outside Docker (Tart).
 */
export function outto(): Tool {
  return {
    name: `outto (${RELEASE_TAG} @ ${REFRESH})`,
    render: (ctx) => {
      if (ctx.platform !== "windows") {
        throw new Error(
          `outto tool: only the windows image is wired up; ` +
            `current platform is "${ctx.platform}"`,
        )
      }

      const apiUrl =
        `https://api.github.com/repos/${REPO}/releases/tags/${RELEASE_TAG}`
      const assetPattern = assetPsPattern(
        "outto",
        "x86_64-pc-windows-msvc",
        "zip",
      )

      return [
        `RUN Write-Output 'outto ${RELEASE_TAG} refresh: ${REFRESH}' ; \\`,
        `    $rel = Invoke-RestMethod -Uri '${apiUrl}' ; \\`,
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
