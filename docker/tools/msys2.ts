import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install MSYS2 (provides pacman'd flex/bison/patch for autotools-style builds
 * that aren't available natively on Windows).
 */
export function msys2(opts: {
  /** Date-stamped installer build (see msys2/msys2-installer releases). */
  installerDate?: string
  /** Extra packages to pacman -S after installation. */
  packages?: string[]
} = {}): Tool {
  const installerDate = opts.installerDate ?? versions.msys2
  const compactDate = installerDate.replace(/-/g, "")
  const packages = opts.packages ?? ["flex", "bison", "patch"]
  return {
    name: `MSYS2 (${installerDate})`,
    render: () =>
      [
        `RUN Invoke-WebRequest -Uri "https://github.com/msys2/msys2-installer/releases/download/${installerDate}/msys2-x86_64-${compactDate}.exe" -OutFile msys2-installer.exe ; \\`,
        `    Start-Process -Wait -FilePath .\\msys2-installer.exe -ArgumentList @('install', '--root', 'C:\\MSYS2', '--confirm-command') ; \\`,
        `    Remove-Item -Force msys2-installer.exe ; \\`,
        `    C:\\MSYS2\\usr\\bin\\bash.exe -lc '/usr/bin/pacman -Syu --noconfirm' ; \\`,
        `    C:\\MSYS2\\usr\\bin\\bash.exe -lc '/usr/bin/pacman -S --noconfirm ${
          packages.join(" ")
        }'`,
      ].join("\n"),
  }
}
