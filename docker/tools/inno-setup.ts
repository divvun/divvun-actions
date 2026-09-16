import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install Inno Setup silently from its GitHub release.
 *
 * The previous source, `jrsoftware.org/download.php/is.exe?site=2`, now
 * redirects to an HTML download page. Invoke-WebRequest followed the redirect
 * and saved ~10KB of HTML as innosetup.exe, so the install died with "The file
 * or directory is corrupted and unreadable" — a failure that only surfaced once
 * the layer cache was invalidated. The release asset is a pinned, direct
 * download, and the header check below turns any future URL rot back into an
 * obvious error at download time.
 */
export function innoSetup(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.innosetup
  const tag = `is-${version.replace(/\./g, "_")}`
  const major = version.split(".")[0]
  return {
    name: `Inno Setup ${version}`,
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri "https://github.com/jrsoftware/issrc/releases/download/${tag}/innosetup-${version}.exe" -OutFile innosetup.exe; \\`,
        `    $head = Get-Content innosetup.exe -AsByteStream -TotalCount 2; \\`,
        `    if ($head.Length -ne 2 -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) { throw 'innosetup.exe is not a PE image; the download URL likely returned an HTML page' }; \\`,
        `    Start-Process -FilePath .\\innosetup.exe -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP-' -Wait; \\`,
        `    Remove-Item innosetup.exe; \\`,
        `    setx /M PATH $($Env:PATH + ';C:\\Program Files (x86)\\Inno Setup ${major}');`,
      ].join("\n"),
  }
}
