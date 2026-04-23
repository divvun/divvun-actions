import type { Tool } from "../lib/image.ts"

/**
 * Switch the default Ubuntu mirror to the Finnish mirror (lower latency for
 * our NO/FI-based infra), restrict to amd64 so apt doesn't fetch arm64 lists,
 * then install the Apertium nightly apt source.
 *
 * Must run before any other apt-related preInstall so downstream repos can
 * rely on the reduced index size.
 */
export function ubuntuFinnishMirrorWithApertium(): Tool {
  return {
    name: "ubuntu: Finnish mirror + amd64 only + apertium nightly",
    render: () =>
      [
        `RUN sed -i 's/archive\\.ubuntu/fi\\.archive\\.ubuntu/g' /etc/apt/sources.list.d/ubuntu.sources && \\`,
        `    sed -i 's/security\\.ubuntu/fi\\.archive\\.ubuntu/g' /etc/apt/sources.list.d/ubuntu.sources && \\`,
        `    sed -i '/^Types:/a Architectures: amd64' /etc/apt/sources.list.d/ubuntu.sources && \\`,
        `    curl -fsSL https://apertium.projectjj.com/apt/install-nightly.sh | bash`,
      ].join("\n"),
  }
}
