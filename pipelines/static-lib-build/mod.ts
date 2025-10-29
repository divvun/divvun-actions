import * as path from "@std/path"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

const PYTORCH_VERSION = "v2.8.0"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

function scriptPath(scriptName: string): string {
  const dir = path.dirname(import.meta.filename!)
  return path.join(dir, scriptName)
}

export function pipelineStaticLibBuild(): BuildkitePipeline {
  const pipeline: BuildkitePipeline = {
    env: {
      PYTORCH_VERSION,
    },
    steps: [
      {
        group: ":apple: macOS Builds",
        steps: [
          command({
            label: "macOS ARM64: ICU",
            key: "macos-arm64-icu",
            command: [
              "set -e",
              "divvun-actions run icu4c-build aarch64-apple-darwin",
              "tar -czf target/icu4c_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin icu4c",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: ["target/icu4c_aarch64-apple-darwin.tar.gz"],
          }),
          command({
            label: "macOS ARM64: LibOMP",
            key: "macos-arm64-libomp",
            command: [
              "set -e",
              "divvun-actions run libomp-build aarch64-apple-darwin",
              "tar -czf target/libomp_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin libomp",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: ["target/libomp_aarch64-apple-darwin.tar.gz"],
          }),
          command({
            label: "macOS ARM64: Protobuf",
            key: "macos-arm64-protobuf",
            command: [
              "set -e",
              "divvun-actions run protobuf-build aarch64-apple-darwin",
              "tar -czf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin protobuf",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: ["target/protobuf_aarch64-apple-darwin.tar.gz"],
          }),
          command({
            label: "macOS ARM64: PyTorch",
            key: "macos-arm64-pytorch",
            depends_on: "macos-arm64-protobuf",
            command: [
              "set -e",
              "divvun-actions run download-cache",
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-darwin.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin",
              "tar -xzf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              `${scriptPath("build-pytorch.sh")} --target aarch64-apple-darwin`,
              "tar -czf target/pytorch_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin pytorch",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: ["target/pytorch_aarch64-apple-darwin.tar.gz"],
          }),
        ],
      },
      {
        group: ":iphone: iOS Builds",
        steps: [
          command({
            label: "iOS ARM64: ICU",
            key: "ios-arm64-icu",
            command: [
              "set -e",
              "divvun-actions run icu4c-build aarch64-apple-ios",
              "tar -czf target/icu4c_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios icu4c",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: ["target/icu4c_aarch64-apple-ios.tar.gz"],
          }),
          command({
            label: "iOS ARM64: Protobuf",
            key: "ios-arm64-protobuf",
            depends_on: "macos-arm64-protobuf",
            command: [
              "set -e",
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-darwin.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin",
              "tar -xzf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "divvun-actions run protobuf-build aarch64-apple-ios",
              "tar -czf target/protobuf_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios protobuf",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: ["target/protobuf_aarch64-apple-ios.tar.gz"],
          }),
          command({
            label: "iOS ARM64: PyTorch",
            key: "ios-arm64-pytorch",
            depends_on: ["macos-arm64-protobuf", "ios-arm64-protobuf"],
            command: [
              "set -e",
              "divvun-actions run download-cache",
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-darwin.tar.gz" .',
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-ios.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin target/aarch64-apple-ios",
              "tar -xzf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "tar -xzf target/protobuf_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios",
              `${scriptPath("build-pytorch.sh")} --target aarch64-apple-ios`,
              "tar -czf target/pytorch_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios pytorch",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: ["target/pytorch_aarch64-apple-ios.tar.gz"],
          }),
        ],
      },
      {
        group: ":android: Android Builds",
        steps: [
          command({
            label: "Android ARM64: ICU",
            key: "android-arm64-icu",
            command: [
              "set -e",
              "divvun-actions run icu4c-build aarch64-linux-android",
              "tar -czf target/icu4c_aarch64-linux-android.tar.gz -C target/aarch64-linux-android icu4c",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/icu4c_aarch64-linux-android.tar.gz"],
          }),
          command({
            label: "Android ARM64: Protobuf",
            key: "android-arm64-protobuf",
            depends_on: "linux-x86_64-protobuf",
            command: [
              "set -e",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "tar -xzf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "divvun-actions run protobuf-build aarch64-linux-android",
              "tar -czf target/protobuf_aarch64-linux-android.tar.gz -C target/aarch64-linux-android protobuf",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/protobuf_aarch64-linux-android.tar.gz"],
          }),
          command({
            label: "Android ARM64: PyTorch",
            key: "android-arm64-pytorch",
            depends_on: ["linux-x86_64-protobuf", "android-arm64-protobuf"],
            command: [
              "set -e",
              "divvun-actions run download-cache",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              'buildkite-agent artifact download "target/protobuf_aarch64-linux-android.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu target/aarch64-linux-android",
              "tar -xzf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "tar -xzf target/protobuf_aarch64-linux-android.tar.gz -C target/aarch64-linux-android",
              `ANDROID_NDK=$ANDROID_NDK_HOME ${scriptPath("build-pytorch.sh")} --target aarch64-linux-android`,
              "tar -czf target/pytorch_aarch64-linux-android.tar.gz -C target/aarch64-linux-android pytorch",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/pytorch_aarch64-linux-android.tar.gz"],
          }),
        ],
      },
      {
        group: ":linux: Linux Builds",
        steps: [
          command({
            label: "Linux x86_64: ICU",
            key: "linux-x86_64-icu",
            command: [
              "set -e",
              "divvun-actions run icu4c-build x86_64-unknown-linux-gnu",
              "tar -czf target/icu4c_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu icu4c",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/icu4c_x86_64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux x86_64: LibOMP",
            key: "linux-x86_64-libomp",
            command: [
              "set -e",
              "divvun-actions run libomp-build x86_64-unknown-linux-gnu",
              "tar -czf target/libomp_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu libomp",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/libomp_x86_64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux x86_64: Protobuf",
            key: "linux-x86_64-protobuf",
            command: [
              "set -e",
              "divvun-actions run protobuf-build x86_64-unknown-linux-gnu",
              "tar -czf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu protobuf",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/protobuf_x86_64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux x86_64: PyTorch",
            key: "linux-x86_64-pytorch",
            depends_on: "linux-x86_64-protobuf",
            command: [
              "set -e",
              "divvun-actions run download-cache",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "tar -xzf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              `${scriptPath("build-pytorch.sh")} --target x86_64-unknown-linux-gnu`,
              "tar -czf target/pytorch_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu pytorch",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/pytorch_x86_64-unknown-linux-gnu.tar.gz"],
          }),
        ],
      },
      {
        group: ":windows: Windows Builds",
        steps: [
          command({
            label: "Windows x86_64: ICU",
            key: "windows-x86_64-icu",
            command: [
              "divvun-actions run icu4c-build x86_64-pc-windows-msvc",
              'C:\\msys2\\usr\\bin\\bash.exe -c "bsdtar -czf target/icu4c_x86_64-pc-windows-msvc.tar.gz -C target/x86_64-pc-windows-msvc icu4c"',
            ].join("\n"),
            agents: {
              queue: "windows",
            },
            env: {
              MSYSTEM: "CLANG64",
            },
            artifact_paths: ["target/icu4c_x86_64-pc-windows-msvc.tar.gz"],
          }),
        ],
      },
    ],
  }

  return pipeline
}
