import type { Tool } from "../lib/image.ts"

/** Install the Chocolatey package manager. */
export function chocolatey(): Tool {
  return {
    name: "chocolatey",
    render: () =>
      [
        `RUN Set-ExecutionPolicy Bypass -Scope Process -Force; \\`,
        `    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; \\`,
        `    iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))`,
      ].join("\n"),
  }
}

/** Install one chocolatey package, optionally pinning a version. */
export function chocoInstall(opts: {
  package: string
  version?: string
  /** Extra args after `-y` (e.g. `--params="..."`). */
  extraArgs?: string[]
  /** Extra ENV/PATH lines emitted after the install. */
  postInstall?: string[]
}): Tool {
  const args = [`-y`]
  if (opts.version) args.unshift(`--version="${opts.version}"`)
  if (opts.extraArgs) args.push(...opts.extraArgs)
  const lines = [`RUN choco install ${opts.package} ${args.join(" ")}`]
  if (opts.postInstall) lines.push(...opts.postInstall)
  return {
    name: opts.version
      ? `choco install ${opts.package}@${opts.version}`
      : `choco install ${opts.package}`,
    render: () => lines.join("\n"),
  }
}
