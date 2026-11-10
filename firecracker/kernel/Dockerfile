# Guest kernel for the Firecracker microVMs. Build args come from
# firecracker/versions.ts via `divvun-actions run divvun-actions-build-image
# fc-kernel`; there are no defaults so a build cannot drift from them.
#
# The result is a FROM scratch image holding /vmlinux and /config, which the
# hosts read with `crane export`.

FROM ubuntu:24.04 AS build

ARG KERNEL_TAG
ARG FIRECRACKER_VERSION
ARG KERNEL_CONFIG

RUN test -n "$KERNEL_TAG" && test -n "$FIRECRACKER_VERSION" && test -n "$KERNEL_CONFIG"

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bc bison build-essential ca-certificates curl dwarves flex libelf-dev \
    libssl-dev python3 xz-utils && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src

RUN curl -fsSL "https://github.com/amazonlinux/linux/archive/refs/tags/${KERNEL_TAG}.tar.gz" \
    | tar -xz --strip-components=1

RUN curl -fsSL -o base.config \
    "https://raw.githubusercontent.com/firecracker-microvm/firecracker/${FIRECRACKER_VERSION}/resources/guest_configs/${KERNEL_CONFIG}"

COPY divvun.config /src/divvun.config

# merge_config.sh only warns when a requested value is dropped, so check
# every line of the fragment against the final .config.
RUN scripts/kconfig/merge_config.sh -m base.config divvun.config && \
    make olddefconfig && \
    missing=0 && \
    for opt in $(grep -E '^CONFIG_' divvun.config); do \
      grep -qx "$opt" .config || { echo "not in final .config: $opt" >&2; missing=1; }; \
    done && \
    test "$missing" -eq 0

RUN make -j"$(nproc)" vmlinux

FROM scratch
COPY --from=build /src/vmlinux /vmlinux
COPY --from=build /src/.config /config
