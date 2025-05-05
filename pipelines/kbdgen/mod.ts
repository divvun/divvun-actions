import { BuildkitePipeline } from "../../builder/pipeline.ts"

const platforms = {
  macos: ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  linux: ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"],
  windows: ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"],
}

export function kbdgenPipeline() {
  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  for (const [os, archs] of Object.entries(platforms)) {
    for (const arch of archs) {
      pipeline.steps.push({
        group: `${os} ${arch}`,
        agents: {
          queue: os,
        },
        steps: [
          {
            label: "Build",
            command: `cargo build --release --target ${arch}`,
          },
          {
            label: "Sign",
            command: `cargo sign target/${arch}/release/kbdgen${os === "windows" ? ".exe" : ""}`,
          },
        ],
      })
    }
  }

  return pipeline
}
