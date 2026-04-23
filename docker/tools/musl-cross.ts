import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

export type MuslArch = "x86_64" | "aarch64"

/**
 * Install a standalone musl cross-compiler from musl.cc and symlink the
 * canonical `<arch>-linux-musl-<tool>` binaries into /usr/local/bin.
 */
export function muslCross(opts: { arch: MuslArch }): Tool {
  const url = versions.musl[opts.arch]
  const prefix = `${opts.arch}-linux-musl`
  const optDir = `/opt/${prefix}-cross`
  return {
    name: `${prefix} cross-compiler`,
    render: () => {
      const lines = [
        `curl -fsSL ${url} -o ${opts.arch}-musl-cross.tgz`,
        `tar -xzf ${opts.arch}-musl-cross.tgz -C /opt`,
        `rm ${opts.arch}-musl-cross.tgz`,
      ]
      for (const bin of ["gcc", "g++", "ar", "ranlib"]) {
        lines.push(
          `ln -s ${optDir}/bin/${prefix}-${bin} /usr/local/bin/${prefix}-${bin}`,
        )
      }
      return `RUN ${lines.join(" && \\\n    ")}`
    },
  }
}
