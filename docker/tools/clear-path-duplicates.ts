import type { Tool } from "../lib/image.ts"

/** Deduplicate the system PATH after a long sequence of `setx /M PATH` appends. */
export function clearPathDuplicates(): Tool {
  return {
    name: "Clear PATH duplicates",
    render: () =>
      [
        `RUN $cleanPath = ($Env:PATH -split ';' | Select-Object -Unique) -join ';' ; \\`,
        `    setx /M PATH $cleanPath`,
      ].join("\n"),
  }
}
