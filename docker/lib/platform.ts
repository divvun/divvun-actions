export type Platform = "ubuntu" | "alpine" | "windows"
export type ShellKind = "bash-lic" | "pwsh" | "cmd"

export type RenderCtx = {
  platform: Platform
  shell: ShellKind
}

export function dockerfileShellDirective(shell: ShellKind): string[] {
  switch (shell) {
    case "bash-lic":
      return ["bash", "-lic"]
    case "pwsh":
      return [
        "pwsh",
        "-command",
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';",
      ]
    case "cmd":
      return ["cmd", "/S", "/C"]
  }
}

export function joinShellLines(lines: string[], shell: ShellKind): string {
  switch (shell) {
    case "bash-lic":
      return lines.join(" && \\\n    ")
    case "pwsh":
      return lines.join(" ; \\\n    ")
    case "cmd":
      return lines.join(" && \\\n    ")
  }
}
