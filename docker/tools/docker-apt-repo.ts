import type { Tool } from "../lib/image.ts"

/**
 * Install the official Docker apt keyring + sources.list entry on Ubuntu,
 * so packages like `docker-ce`, `containerd.io`, `docker-buildx-plugin` can
 * be apt-installed later.
 */
export function dockerAptRepo(): Tool {
  return {
    name: "apt repo: docker.com",
    render: () =>
      [
        `RUN install -m 0755 -d /etc/apt/keyrings && \\`,
        `    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && \\`,
        `    chmod a+r /etc/apt/keyrings/docker.asc && \\`,
        `    echo \\`,
        `        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \\`,
        `        $(. /etc/os-release && echo "${"${UBUNTU_CODENAME:-$VERSION_CODENAME}"}") stable" | \\`,
        `        tee /etc/apt/sources.list.d/docker.list > /dev/null`,
      ].join("\n"),
  }
}
