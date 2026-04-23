import type { Tool } from "../lib/image.ts"

/** Install astral's `uv` via the official install.sh (writes into ~/.local/bin). */
export function uv(): Tool {
  return {
    name: "uv",
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return [
          `RUN irm https://astral.sh/uv/install.ps1 | iex ; \\`,
          `    setx /M PATH $($Env:PATH + ';C:\\Users\\ContainerAdministrator\\.local\\bin')`,
        ].join("\n")
      }
      return `RUN curl -LsSf https://astral.sh/uv/install.sh | sh`
    },
  }
}
