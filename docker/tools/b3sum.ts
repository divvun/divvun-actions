import type { Tool } from "../lib/image.ts"

/** Install the prebuilt b3sum binary (linux x64). */
export function b3sum(): Tool {
  return {
    name: "b3sum",
    render: () =>
      [
        `RUN curl -fsSL "https://github.com/BLAKE3-team/BLAKE3/releases/latest/download/b3sum_linux_x64_bin" -o /usr/local/bin/b3sum && \\`,
        `    chmod +x /usr/local/bin/b3sum`,
      ].join("\n"),
  }
}
