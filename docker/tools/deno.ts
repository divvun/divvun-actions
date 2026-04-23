import type { Tool } from "../lib/image.ts"

/**
 * Install Deno.
 *
 * - linux (ubuntu): official install.sh
 * - alpine: uses the `deno` apk package instead — do NOT use this tool for alpine
 * - windows: install.ps1
 */
export function deno(): Tool {
  return {
    name: "deno",
    render: (ctx) => {
      if (ctx.platform === "alpine") {
        throw new Error(
          "deno() tool is not needed on alpine — use the `deno` apk package instead",
        )
      }
      if (ctx.platform === "windows") {
        return `RUN irm https://deno.land/install.ps1 | iex`
      }
      return `RUN curl -fsSL https://deno.land/install.sh | bash -s -- -y`
    },
  }
}
