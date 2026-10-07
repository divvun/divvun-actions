import type { Tool } from "../lib/image.ts"

/**
 * MSVC library architectures cargo-xwin fetches, covering the
 * x86_64, i686 and aarch64 pc-windows-msvc targets. Set in the image so a
 * build asks for exactly what was cached; without x86, i686 cannot link.
 */
export const XWIN_ARCH = "x86,x86_64,aarch64"

/**
 * Set up cargo-xwin, which cross-compiles `*-pc-windows-msvc` on Linux with
 * clang-cl, lld-link and the Microsoft CRT and Windows SDK, so Windows
 * binaries build without a Windows agent. Expects `rust()` to have installed
 * cargo-xwin and the Windows targets.
 *
 * - The LLVM packages only ship versioned clang-cl / lld-link / llvm-lib /
 *   llvm-rc; cargo-xwin looks for the unversioned names.
 * - cargo-xwin-clang.sh becomes `clang`, for ring's aarch64 build (see the
 *   script).
 * - The CRT and SDK are cached into root's ~/.cache/cargo-xwin, where the
 *   builds (also root) look, so no build downloads them.
 */
export function cargoXwin(opts: { llvm: number }): Tool {
  const bin = `/usr/lib/llvm-${opts.llvm}/bin`
  return {
    name: `cargo-xwin (MSVC CRT + SDK for ${XWIN_ARCH})`,
    render: () =>
      [
        `RUN ln -sf ${bin}/clang-cl /usr/local/bin/clang-cl && \\`,
        `    ln -sf ${bin}/lld-link /usr/local/bin/lld-link && \\`,
        `    ln -sf ${bin}/llvm-lib /usr/local/bin/llvm-lib && \\`,
        `    ln -sf ${bin}/llvm-rc /usr/local/bin/llvm-rc`,
        `COPY cargo-xwin-clang.sh /usr/local/bin/clang`,
        `RUN chmod +x /usr/local/bin/clang`,
        `ENV XWIN_ARCH=${JSON.stringify(XWIN_ARCH)}`,
        `RUN cargo xwin cache xwin`,
      ].join("\n"),
  }
}
