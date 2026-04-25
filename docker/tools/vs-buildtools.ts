import type { Tool } from "../lib/image.ts"

const DEFAULT_WORKLOADS = [
  "Microsoft.VisualStudio.Workload.VCTools",
  "Microsoft.VisualStudio.Workload.MSBuildTools",
  "Microsoft.VisualStudio.Workload.NetCoreBuildTools",
  "Microsoft.VisualStudio.Workload.NativeDesktop",
  "Microsoft.VisualStudio.Workload.ManagedDesktop",
]

const DEFAULT_COMPONENTS = [
  "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
  "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
  "Microsoft.VisualStudio.Component.VC.Llvm.Clang",
  "Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset",
  "Microsoft.VisualStudio.Component.Windows11SDK.26100",
]

const DEFAULT_REMOVALS = [
  "Microsoft.VisualStudio.Component.Windows10SDK.10240",
  "Microsoft.VisualStudio.Component.Windows10SDK.10586",
  "Microsoft.VisualStudio.Component.Windows10SDK.14393",
  "Microsoft.VisualStudio.Component.Windows81SDK",
]

/**
 * Install Visual Studio 2022 Build Tools using a quiet/wait/norestart layered
 * MSI install. Requires:
 *   - install-vsbase.cmd present at C:\TEMP\ (COPY first)
 *   - C:\TEMP\VisualStudio.chman channel manifest (ADD via aka.ms/vs/17/release/channel)
 *   - C:\TEMP\collect.exe for log collection on failure (ADD via aka.ms/vscollect.exe)
 */
export function vsBuildTools(opts: {
  workloads?: string[]
  components?: string[]
  remove?: string[]
} = {}): Tool {
  const workloads = opts.workloads ?? DEFAULT_WORKLOADS
  const components = opts.components ?? DEFAULT_COMPONENTS
  const remove = opts.remove ?? DEFAULT_REMOVALS

  const adds = [...workloads, ...components].map((c) => `        --add ${c} \``)
  const removes = remove.map((c, i) =>
    i === remove.length - 1
      ? `        --remove ${c}) \``
      : `        --remove ${c} \``
  )

  return {
    name: "Visual Studio Build Tools 2022",
    render: () =>
      [
        `RUN powershell -Command "$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vs_buildtools.exe' -OutFile 'vs_buildtools.exe'" \``,
        `    && (call C:\\TEMP\\install-vsbase.cmd vs_buildtools.exe --quiet --wait --norestart --nocache install \``,
        `        --installPath "%ProgramFiles(x86)%\\Microsoft Visual Studio\\2022\\BuildTools" \``,
        `        --channelUri C:\\TEMP\\VisualStudio.chman \``,
        `        --installChannelUri C:\\TEMP\\VisualStudio.chman \``,
        ...adds,
        ...removes,
        `    && del /q vs_buildtools.exe \``,
        `    && (rmdir /s /q "C:\\ProgramData\\Package Cache" 2>nul || exit /b 0)`,
      ].join("\n"),
  }
}
