import type { Tool } from "../lib/image.ts"

/**
 * Symlink the clang-21 / lld-21 etc. binaries to unversioned names so
 * that plain `clang` / `lld` pick up the right version.
 *
 * Alpine names the LLVM binaries without the hyphen (`clang-21` -> `clang21`,
 * `ld.lld-21` -> `ld.lld21`), so we gate on platform.
 */
export function clangSymlinks(opts: { version: number }): Tool {
  return {
    name: `clang-${opts.version} symlinks as default`,
    render: (ctx) => {
      const v = opts.version
      if (ctx.platform === "alpine") {
        return [
          `RUN ln -sf /usr/bin/clang-${v} /usr/local/bin/clang && \\`,
          `    ln -sf /usr/bin/clang++-${v} /usr/local/bin/clang++ && \\`,
          `    ln -sf /usr/bin/lld${v} /usr/local/bin/lld && \\`,
          `    ln -sf /usr/bin/ld.lld${v} /usr/local/bin/ld.lld`,
        ].join("\n")
      }
      // ubuntu (update-alternatives)
      return [
        `RUN update-alternatives --install /usr/bin/clang clang /usr/bin/clang-${v} 100 && \\`,
        `    update-alternatives --install /usr/bin/clang++ clang++ /usr/bin/clang++-${v} 100 && \\`,
        `    update-alternatives --install /usr/bin/lld lld /usr/bin/lld-${v} 100 && \\`,
        `    update-alternatives --install /usr/bin/ld.lld ld.lld /usr/bin/ld.lld-${v} 100`,
      ].join("\n")
    },
  }
}
