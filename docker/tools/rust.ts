import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

export type RustOpts = {
  /**
   * Toolchain to install as the default. Pinned rather than `stable` so the
   * emitted RUN line changes when the pin moves — an unpinned `stable` install
   * is a stable cache key, so Docker keeps serving whatever compiler was
   * current the day the layer was first built.
   */
  version?: string
  /** Rust target triples to add on install. */
  targets?: string[]
  /** Extra cargo-binstall packages to install (e.g. "just", "cargo-ndk"). */
  binstall?: string[]
  /** Extra `cargo install` git sources (e.g. cross). */
  gitInstalls?: Array<{ name: string; url: string }>
}

export function rust(opts: RustOpts = {}): Tool {
  const version = opts.version ?? versions.rust
  return {
    name: `rust@${version} (targets: ${opts.targets?.join(", ") ?? "default"})`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        const lines = [
          `Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile rustup-init.exe`,
        ]
        const args = ["'-y'", "'--default-toolchain'", `'${version}'`]
        for (const t of opts.targets ?? []) {
          args.push("'--target'", `'${t}'`)
        }
        lines.push(
          `Start-Process -FilePath .\\\\rustup-init.exe -ArgumentList @(${
            args.join(", ")
          }) -NoNewWindow -Wait`,
        )
        lines.push(`Remove-Item -Force .\\\\rustup-init.exe`)
        return `RUN ${lines.join("; \\\n    ")}`
      }

      // bash (ubuntu + alpine)
      const installLine =
        `curl --proto '=https' --tlsv1.2 -sSf ${versions.rustupScriptSource} | sh -s -- -y \\\n    --default-toolchain ${version}` +
        (opts.targets?.map((t) => ` \\\n    -t ${t}`).join("") ?? "")
      const out: string[] = [
        `RUN ${installLine}`,
        `ENV PATH="/root/.cargo/bin:${"${PATH}"}"`,
      ]

      if (opts.gitInstalls?.length || opts.binstall?.length) {
        const lines: string[] = []
        for (const g of opts.gitInstalls ?? []) {
          lines.push(`~/.cargo/bin/cargo install ${g.name} --git ${g.url}`)
        }
        if (opts.binstall?.length) {
          lines.push(
            `curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash`,
          )
          for (const b of opts.binstall) {
            lines.push(`~/.cargo/bin/cargo binstall -y ${b}`)
          }
        }
        out.push("")
        out.push(`# rust extras`)
        out.push(`RUN ${lines.join(" && \\\n    ")}`)
      }
      return out.join("\n")
    },
  }
}
