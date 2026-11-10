/**
 * Everything the Firecracker hosts and the guest kernel are pinned to.
 *
 * Bump the kernel together with Firecracker: the guest config comes from the
 * Firecracker release, and Firecracker validates it only against the Amazon
 * Linux `microvm-kernel-*` tree of the same series (docs/kernel-policy.md).
 */
export const fcVersions = {
  firecracker: {
    version: "v1.17.0",
    sha256: "06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558",
  },
  crane: {
    version: "v0.22.1",
    sha256: "0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0",
  },
  kernel: {
    /** Tag in github.com/amazonlinux/linux. */
    tag: "microvm-kernel-6.18.25-57.115.amzn2023",
    /** resources/guest_configs/<name> in the Firecracker release above. */
    config: "microvm-kernel-ci-x86_64-6.18.config",
  },
}

export const KERNEL_IMAGE_REF = "ghcr.io/divvun/divvun-actions:fc-kernel-latest"
