export const versions = {
  openbao: "2.7.1",
  gh: "2.102.0",
  minisign: "0.12",
  just: "1.58.0",
  nodejs: "24.x",
  uv: "0.12.23",
  box: "da96a74656aef7f582a061c16fc0b70288ed514a",
  llvm: 23,
  // Alpine's own LLVM packages, which stop short of the Ubuntu version above.
  // The alpine image's package list and the static-lib-build pipelines
  // (/usr/lib/llvm21) hardcode this too.
  alpineLlvm: 21,
  ndk: "30.0.16248370",
  cmake: "3.31.12",
  ninja: "1.13.2",
  vulkan: "1.4.363.0",
  libtorch: "2.14.1",
  rustupScriptSource: "https://sh.rustup.rs",
  rust: "1.99.0",
  vcpkg: "2026.07.29",
  nodeChocoVersion: "24.21.0",
  openssh: "10.0.0.0",
  alpine: "3.24",
  // Stays on the 6.x line: 7.x installs to a different directory and is not a
  // drop-in for the existing .iss scripts. 6.x is still maintained upstream.
  innosetup: "6.7.3",
  msys2: "2026-09-27",
  powershellCore: "7.6.6",
  gitForWindows: "2.56.0",
  musl: {
    x86_64: "https://musl.cc/x86_64-linux-musl-cross.tgz",
    aarch64: "https://musl.cc/aarch64-linux-musl-cross.tgz",
  },
  pahkatDevtoolsChannel: "nightly",
  rcodesign: "0.29.0",
}
