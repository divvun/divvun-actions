import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/** Install the pinned `uv` used to resolve divvun-speech-py's committed lock. */
export function uv(): Tool {
  return {
    name: `uv ${versions.uv}`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return [
          `RUN irm https://astral.sh/uv/${versions.uv}/install.ps1 | iex ; \\`,
          `    setx /M PATH $($Env:PATH + ';C:\\Users\\ContainerAdministrator\\.local\\bin')`,
        ].join("\n")
      }
      return `RUN curl -LsSf https://astral.sh/uv/${versions.uv}/install.sh | sh`
    },
  }
}
