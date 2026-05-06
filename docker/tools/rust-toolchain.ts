import type { Tool } from "../lib/image.ts"

export type RustToolchainOpts = {
  /** Channel/toolchain name: "nightly", "stable", "1.80.0", etc. */
  channel: string
  /** Components to install alongside the toolchain (e.g. "rust-src"). */
  components?: string[]
  /** Extra target triples to add to this toolchain. */
  targets?: string[]
}

/**
 * Install an additional rustup toolchain on top of the default one. Use this
 * when a build needs a non-default channel (e.g. nightly + rust-src for
 * `-Zbuild-std=std`). Assumes `rust()` already ran first.
 */
export function rustToolchain(opts: RustToolchainOpts): Tool {
  return {
    name: `rust-${opts.channel}` +
      (opts.components?.length ? ` (${opts.components.join(", ")})` : ""),
    render: (ctx) => {
      const installFlags: string[] = [opts.channel]
      for (const c of opts.components ?? []) {
        installFlags.push(`--component`, c)
      }
      const lines: string[] = [
        `rustup toolchain install ${installFlags.join(" ")}`,
      ]
      for (const t of opts.targets ?? []) {
        lines.push(`rustup target add ${t} --toolchain ${opts.channel}`)
      }

      const sep = ctx.platform === "windows" ? " ; \\\n    " : " && \\\n    "
      return `RUN ${lines.join(sep)}`
    },
  }
}
