import type { Tool } from "../lib/image.ts"

/** Create a directory (idempotently). */
export function mkdir(
  opts: { path: string; label?: string },
): Tool {
  return {
    name: opts.label ?? `mkdir ${opts.path}`,
    render: (ctx) => {
      if (ctx.platform === "windows") {
        return `RUN New-Item -ItemType Directory -Path ${opts.path} -Force | Out-Null`
      }
      return `RUN mkdir -p ${opts.path}`
    },
  }
}
