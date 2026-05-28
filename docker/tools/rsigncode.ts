import type { Tool } from "../lib/image.ts"

/**
 * Install rsigncode (Authenticode signing tool, Rust port of osslsigncode)
 * from divvun/rsigncode. Must be ordered AFTER `rust()` so cargo is on PATH.
 *
 * Replaces the chocolatey osslsigncode package on Windows, whose pinned
 * version lacks the `extract-data` subcommand we need for detached signing.
 */
export function rsigncode(): Tool {
  return {
    name: "rsigncode",
    render: () =>
      `RUN cargo install --git https://github.com/divvun/rsigncode rsigncode-cli --locked`,
  }
}
