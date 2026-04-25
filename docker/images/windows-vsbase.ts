import { defineImage } from "../lib/image.ts"
import {
  addUrl,
  arg,
  copyFile,
  powershellCore,
  raw,
  vsBuildTools,
} from "../tools/mod.ts"

export default defineImage({
  target: "windows-vsbase",
  imageRef:
    "ghcr.io/divvun/lts-windowsservercore-ltsc2022-vs2022:latest",
  base: "mcr.microsoft.com/windows/servercore:ltsc2022",
  platform: "windows",
  shell: "cmd",
  escape: "`",
  tools: [
    raw(
      "Enable long paths",
      `RUN reg add "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f`,
    ),
    copyFile(
      "Copy install helper script",
      "install-vsbase.cmd",
      "C:\\TEMP\\",
    ),
    addUrl(
      "Download VS log collector for debugging failed installs",
      "https://aka.ms/vscollect.exe",
      "C:\\TEMP\\collect.exe",
    ),
    arg("CHANNEL_URL", "https://aka.ms/vs/17/release/channel"),
    addUrl(
      "Download channel manifest for reproducible installs",
      "${CHANNEL_URL}",
      "C:\\TEMP\\VisualStudio.chman",
    ),
    vsBuildTools(),
    powershellCore(),
  ],
})
