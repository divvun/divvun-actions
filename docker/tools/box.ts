import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install the box archive CLI used to package generated TTS bundles. */
export function box(): Tool {
  return {
    name: `box@${versions.box.slice(0, 7)}`,
    render: (ctx) => {
      if (ctx.platform !== "ubuntu") {
        throw new Error(
          `box: only the ubuntu image is configured; current platform is "${ctx.platform}"`,
        )
      }
      return [
        `RUN cargo install box-cli \\`,
        `    --git https://github.com/bbqsrc/box \\`,
        `    --rev ${versions.box} \\`,
        `    --locked`,
      ].join("\n")
    },
  }
}
