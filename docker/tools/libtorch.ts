import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Download the prebuilt libtorch CPU wheel and merge its share/include/lib
 * subtrees into /usr. Used by ExecuTorch builds.
 */
export function libtorch(
  opts: { version?: string; variant?: "cpu" } = {},
): Tool {
  const version = opts.version ?? versions.libtorch
  const variant = opts.variant ?? "cpu"
  return {
    name: `libtorch@${version} (${variant})`,
    render: () =>
      [
        `RUN curl -fsSL https://download.pytorch.org/libtorch/${variant}/libtorch-shared-with-deps-${version}%2B${variant}.zip -o libtorch.zip && \\`,
        `    unzip libtorch.zip && \\`,
        `    cp -ar libtorch/{share,include,lib} /usr && \\`,
        `    rm -rf libtorch && \\`,
        `    rm libtorch.zip`,
      ].join("\n"),
  }
}
