import type { Tool } from "../lib/image.ts"

export type PipxInstallOpts = {
  /** pipx source spec (e.g. `git+https://github.com/divvun/GiellaLTLexTools`). */
  spec: string
  /** Short label for the comment header. Defaults to the spec. */
  label?: string
  /**
   * When true, also emit `ENV PATH="/root/.local/bin:$PATH"` so pipx's
   * default venv bin dir is on PATH. Usually wanted for the first pipx
   * install in an image.
   */
  exportPath?: boolean
}

/** pipx install a python package/CLI. Requires `pipx` in aptPackages. */
export function pipxInstall(opts: PipxInstallOpts): Tool {
  return {
    name: `pipx install ${opts.label ?? opts.spec}`,
    render: () => {
      const lines = [`RUN pipx install ${opts.spec}`]
      if (opts.exportPath) lines.push(`ENV PATH="/root/.local/bin:$PATH"`)
      return lines.join("\n")
    },
  }
}
