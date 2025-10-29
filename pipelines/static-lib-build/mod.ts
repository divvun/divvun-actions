import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

const PYTORCH_VERSION = "v2.8.0"

type LibraryType = "icu4c" | "libomp" | "protobuf" | "pytorch"

interface ReleaseTag {
  library: LibraryType
  version: string
}

function parseReleaseTag(tag: string): ReleaseTag | null {
  // Match tags like: icu4c/v77.1, libomp/v21.1.4, protobuf/v33.0, pytorch/v2.8.0
  const match = tag.match(/^(icu4c|libomp|protobuf|pytorch)\/v?(.+)$/)
  if (!match) return null

  return {
    library: match[1] as LibraryType,
    version: match[2].startsWith("v") ? match[2] : `v${match[2]}`,
  }
}

function getLibraryPlatforms(library: LibraryType): string[] {
  switch (library) {
    case "icu4c":
      return [
        "aarch64-apple-darwin",
        "aarch64-apple-ios",
        "aarch64-linux-android",
        "x86_64-unknown-linux-gnu",
        "x86_64-pc-windows-msvc",
      ]
    case "libomp":
      return ["aarch64-apple-darwin", "x86_64-unknown-linux-gnu"]
    case "protobuf":
      return [
        "aarch64-apple-darwin",
        "aarch64-apple-ios",
        "aarch64-linux-android",
        "x86_64-unknown-linux-gnu",
      ]
    case "pytorch":
      return [
        "aarch64-apple-darwin",
        "aarch64-apple-ios",
        "aarch64-linux-android",
        "x86_64-unknown-linux-gnu",
      ]
  }
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

function generateReleasePipeline(release: ReleaseTag): BuildkitePipeline {
  const { library, version } = release
  const platforms = getLibraryPlatforms(library)

  const pipeline: BuildkitePipeline = {
    steps: [],
  }

  // Add PyTorch cache download step if building PyTorch
  if (library === "pytorch") {
    pipeline.steps.push(
      command({
        label: ":package: Download PyTorch Cache",
        key: "pytorch-cache-download",
        command: `divvun-actions run pytorch-cache-download ${version}`,
        agents: {
          queue: "linux",
        },
      }),
    )
  }

  // Build steps for each platform
  const buildSteps: CommandStep[] = []

  for (const targetTriple of platforms) {
    const queue = targetTriple.includes("windows")
      ? "windows"
      : targetTriple.includes("linux") || targetTriple.includes("android")
      ? "linux"
      : "macos"

    const artifactName = `${library}_${targetTriple}.tar.gz`

    const buildCmd = version
      ? `divvun-actions run ${library}-build ${targetTriple} ${version}`
      : `divvun-actions run ${library}-build ${targetTriple}`

    // For PyTorch builds, add cache download and extraction commands
    const commands = ["set -e"]
    if (library === "pytorch") {
      commands.push(
        'buildkite-agent artifact download "pytorch.tar.gz" .',
        "tar -xzf pytorch.tar.gz",
      )
    }
    commands.push(
      buildCmd,
      targetTriple.includes("windows")
        ? `C:\\msys2\\usr\\bin\\bash.exe -c "bsdtar -czf target/${artifactName} -C target/${targetTriple} ${library}"`
        : `tar -czf target/${artifactName} -C target/${targetTriple} ${library}`,
    )

    buildSteps.push(
      command({
        label: `:package: ${library} ${targetTriple}`,
        key: `${library}-${targetTriple}`,
        depends_on: library === "pytorch"
          ? "pytorch-cache-download"
          : undefined,
        command: commands.join("\n"),
        agents: {
          queue,
        },
        artifact_paths: [`target/${artifactName}`],
      }),
    )
  }

  pipeline.steps.push({
    group: `:package: Build ${library} ${version}`,
    key: `build-${library}`,
    steps: buildSteps,
  })

  // Publish step
  pipeline.steps.push(
    command({
      label: `:rocket: Publish ${library} ${version}`,
      key: `publish-${library}`,
      depends_on: `build-${library}`,
      agents: {
        queue: "linux",
      },
      command: `divvun-actions run publish-library ${library} ${version}`,
    }),
  )

  return pipeline
}

export function pipelineStaticLibBuild(): BuildkitePipeline {
  // Check if this is a release build
  const releaseTag = builder.env.tag ? parseReleaseTag(builder.env.tag) : null

  if (releaseTag) {
    // Generate pipeline for specific library release
    return generateReleasePipeline(releaseTag)
  }

  // Full pipeline for all libraries
  const pipeline: BuildkitePipeline = {
    env: {
      PYTORCH_VERSION,
    },
    steps: [
      // PyTorch cache download step - all PyTorch builds depend on this
      command({
        label: ":package: Download PyTorch Cache",
        key: "pytorch-cache-download",
        command: `divvun-actions run pytorch-cache-download ${PYTORCH_VERSION}`,
        agents: {
          queue: "linux",
        },
        artifact_paths: ["pytorch.tar.gz"],
      }),
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
            depends_on: ["macos-arm64-protobuf", "pytorch-cache-download"],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "tar -xzf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-darwin.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin",
              "tar -xzf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "divvun-actions run pytorch-build aarch64-apple-darwin",
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
            depends_on: [
              "macos-arm64-protobuf",
              "ios-arm64-protobuf",
              "pytorch-cache-download",
            ],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "tar -xzf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-darwin.tar.gz" .',
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-ios.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin target/aarch64-apple-ios",
              "tar -xzf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "tar -xzf target/protobuf_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios",
              "divvun-actions run pytorch-build aarch64-apple-ios",
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
            depends_on: [
              "linux-x86_64-protobuf",
              "android-arm64-protobuf",
              "pytorch-cache-download",
            ],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "tar -xzf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              'buildkite-agent artifact download "target/protobuf_aarch64-linux-android.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu target/aarch64-linux-android",
              "tar -xzf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "tar -xzf target/protobuf_aarch64-linux-android.tar.gz -C target/aarch64-linux-android",
              "ANDROID_NDK=$ANDROID_NDK_HOME divvun-actions run pytorch-build aarch64-linux-android",
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
            depends_on: ["linux-x86_64-protobuf", "pytorch-cache-download"],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "tar -xzf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "tar -xzf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "divvun-actions run pytorch-build x86_64-unknown-linux-gnu",
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
