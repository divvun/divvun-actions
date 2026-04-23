import type { Tool } from "../lib/image.ts"

/**
 * Enable arm64 foreign architecture on Ubuntu, add the ports.ubuntu.com
 * apt repos (needed for arm64 packages since the main mirror is restricted
 * to amd64), then apt-install the cross toolchain and libc/libstdc++ sysroot.
 */
export function arm64UbuntuCross(): Tool {
  return {
    name: "arm64 ubuntu cross-compilation toolchain",
    render: () =>
      [
        `RUN echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports noble main restricted universe multiverse" >> /etc/apt/sources.list.d/arm64.list && \\`,
        `    echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports noble-updates main restricted universe multiverse" >> /etc/apt/sources.list.d/arm64.list && \\`,
        `    echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports noble-backports main restricted universe multiverse" >> /etc/apt/sources.list.d/arm64.list && \\`,
        `    echo "deb [arch=arm64] http://ports.ubuntu.com/ubuntu-ports noble-security main restricted universe multiverse" >> /etc/apt/sources.list.d/arm64.list && \\`,
        `    dpkg --add-architecture arm64 && \\`,
        `    apt-get update && \\`,
        `    DEBIAN_FRONTEND=noninteractive apt-get install -y \\`,
        `    gcc-aarch64-linux-gnu \\`,
        `    g++-aarch64-linux-gnu \\`,
        `    libc6-dev-arm64-cross \\`,
        `    libstdc++-14-dev-arm64-cross && \\`,
        `    rm -rf /var/lib/apt/lists/* && apt-get clean`,
      ].join("\n"),
  }
}
