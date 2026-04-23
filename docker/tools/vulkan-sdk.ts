import type { Tool } from "../lib/image.ts"
import { versions } from "../versions.ts"

/**
 * Install the LunarG Vulkan SDK (required for ExecuTorch's Vulkan backend).
 * Emits ENV VULKAN_SDK + adds its bin dir to PATH.
 */
export function vulkanSdk(opts: { version?: string } = {}): Tool {
  const version = opts.version ?? versions.vulkan
  const sdkPath = `/opt/vulkan/${version}/x86_64`
  return {
    name: `vulkan SDK@${version}`,
    render: () =>
      [
        `ENV VULKAN_SDK="${sdkPath}"`,
        `RUN curl -fsSL https://sdk.lunarg.com/sdk/download/${version}/linux/vulkansdk-linux-x86_64-${version}.tar.xz -o vulkansdk.tar.xz && \\`,
        `    mkdir -p /opt/vulkan && \\`,
        `    tar -xf vulkansdk.tar.xz -C /opt/vulkan && \\`,
        `    rm vulkansdk.tar.xz`,
        `ENV PATH="${"$VULKAN_SDK/bin:$PATH"}"`,
      ].join("\n"),
  }
}
