import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Clone vcpkg at a pinned tag, bootstrap it, add to PATH, and emit the
 * VCPKG_ROOT + VCPKG_DEFAULT_TRIPLET env vars.
 */
export function vcpkg(opts: {
  version?: string
  defaultTriplet?: string
  root?: string
} = {}): Tool {
  const version = opts.version ?? versions.vcpkg
  const root = opts.root ?? "C:\\vcpkg"
  const triplet = opts.defaultTriplet ?? "x64-windows-static"
  return {
    name: `vcpkg ${version}`,
    render: () =>
      [
        `RUN git clone --depth 1 --branch ${version} https://github.com/microsoft/vcpkg.git ${root} ; \\`,
        `    ${root}\\bootstrap-vcpkg.bat -disableMetrics; \\`,
        `    setx /M PATH $($Env:PATH + ';${root}')`,
        ``,
        `ENV VCPKG_ROOT="${root.replace(/\\/g, "\\\\")}"`,
        `ENV VCPKG_DEFAULT_TRIPLET="${triplet}"`,
      ].join("\n"),
  }
}
