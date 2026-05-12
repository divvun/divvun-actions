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
  /**
   * When set, emit `ARG <cacheBust>=0` before the RUN so the layer can be
   * selectively busted without --no-cache. Pass a new value at build time:
   *   docker build --build-arg <cacheBust>=$(date +%s) ...
   */
  cacheBust?: string
}

/** pipx install a python package/CLI. Requires `pipx` in aptPackages. */
export function pipxInstall(opts: PipxInstallOpts): Tool {
  return {
    name: `pipx install ${opts.label ?? opts.spec}`,
    render: () => {
      const lines: string[] = []
      if (opts.cacheBust) lines.push(`ARG ${opts.cacheBust}=0`)
      lines.push(`RUN pipx install ${opts.spec}`)
      if (opts.exportPath) lines.push(`ENV PATH="/root/.local/bin:$PATH"`)
      return lines.join("\n")
    },
  }
}
