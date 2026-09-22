import type { Tool } from "../lib/image.ts"

/** Preinstall a uv-managed Python interpreter in a generated CI image. */
export function uvPython(version: string): Tool {
  return {
    name: `Python ${version} (uv)`,
    render: (ctx) => {
      if (ctx.platform !== "ubuntu") {
        throw new Error(
          `uvPython: only the ubuntu image is configured; current platform is "${ctx.platform}"`,
        )
      }
      return `RUN uv python install ${version}`
    },
  }
}
