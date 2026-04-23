import type { Tool } from "../lib/image.ts"

/**
 * Build a cross-compilation sysroot using `apk --root` against the host
 * Alpine package index. The x86_64 build uses the host's rootfs directly;
 * this tool only covers the non-host arch variant (aarch64).
 *
 * --no-scripts: post-install scripts would fail (can't run aarch64 on x86_64).
 */
export function alpineSysroot(opts: {
  arch: "aarch64"
  packages: string[]
  dest?: string
}): Tool {
  const dest = opts.dest ?? `/opt/sysroot-${opts.arch}`
  const pkgLines = opts.packages.map((p) => `    ${p}`).join(" \\\n")
  return {
    name: `alpine ${opts.arch} sysroot`,
    render: () =>
      [
        `RUN mkdir -p ${dest} && \\`,
        `    apk --arch ${opts.arch} --root ${dest} --initdb \\`,
        `    --repositories-file /etc/apk/repositories --allow-untrusted --no-scripts \\`,
        `    add \\`,
        pkgLines,
      ].join("\n"),
  }
}
