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
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl",
        "x86_64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
        "x86_64-pc-windows-msvc",
      ]
    case "libomp":
      return [
        "aarch64-apple-darwin",
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl",
        "x86_64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
      ]
    case "protobuf":
      return [
        "aarch64-apple-darwin",
        "aarch64-apple-ios",
        "aarch64-linux-android",
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl",
        "x86_64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
      ]
    case "pytorch":
      return [
        "aarch64-apple-darwin",
        "aarch64-apple-ios",
        "aarch64-linux-android",
        "aarch64-unknown-linux-gnu",
        "aarch64-unknown-linux-musl",
        "x86_64-unknown-linux-gnu",
        "x86_64-unknown-linux-musl",
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

    // Build SLEEF for Linux platforms (required for PyTorch)
    const sleefBuildSteps: CommandStep[] = []

    // x86_64 Linux SLEEF
    sleefBuildSteps.push(
      command({
        label: `:package: SLEEF x86_64-unknown-linux-gnu`,
        key: "sleef-x86_64-unknown-linux-gnu",
        command: [
          "set -e",
          "divvun-actions run sleef-build x86_64-unknown-linux-gnu",
          "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu sleef",
          "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu build/sleef",
        ].join("\n"),
        agents: {
          queue: "linux",
        },
        artifact_paths: [
          "target/sleef_x86_64-unknown-linux-gnu.tar.gz",
          "target/sleef-build_x86_64-unknown-linux-gnu.tar.gz",
        ],
      }),
    )

    // aarch64 Linux SLEEF
    sleefBuildSteps.push(
      command({
        label: `:package: SLEEF aarch64-unknown-linux-gnu`,
        key: "sleef-aarch64-unknown-linux-gnu",
        depends_on: "sleef-x86_64-unknown-linux-gnu",
        command: [
          "set -e",
          'buildkite-agent artifact download "target/sleef-build_x86_64-unknown-linux-gnu.tar.gz" .',
          "mkdir -p target/x86_64-unknown-linux-gnu",
          "bsdtar -xf target/sleef-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
          "divvun-actions run sleef-build aarch64-unknown-linux-gnu",
          "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu sleef",
        ].join("\n"),
        agents: {
          queue: "linux",
        },
        artifact_paths: [
          "target/sleef_aarch64-unknown-linux-gnu.tar.gz",
        ],
      }),
    )

    pipeline.steps.push({
      group: ":package: Build SLEEF for PyTorch",
      key: "build-sleef",
      steps: sleefBuildSteps,
    })
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

    // Determine cross-compilation dependencies for ICU4C
    let dependsOn: string | string[] | undefined
    let hostArtifactName: string | undefined
    let hostTargetDir: string | undefined

    if (library === "icu4c") {
      if (targetTriple === "aarch64-apple-ios") {
        dependsOn = "icu4c-aarch64-apple-darwin"
        hostArtifactName = "icu4c_aarch64-apple-darwin.tar.gz"
        hostTargetDir = "aarch64-apple-darwin"
      } else if (targetTriple === "aarch64-linux-android") {
        dependsOn = "icu4c-x86_64-unknown-linux-gnu"
        hostArtifactName = "icu4c_x86_64-unknown-linux-gnu.tar.gz"
        hostTargetDir = "x86_64-unknown-linux-gnu"
      } else if (targetTriple === "aarch64-unknown-linux-gnu") {
        dependsOn = "icu4c-x86_64-unknown-linux-gnu"
        hostArtifactName = "icu4c_x86_64-unknown-linux-gnu.tar.gz"
        hostTargetDir = "x86_64-unknown-linux-gnu"
      }
    } else if (library === "pytorch") {
      // PyTorch depends on cache download and SLEEF for Linux builds
      if (targetTriple === "x86_64-unknown-linux-gnu") {
        dependsOn = ["pytorch-cache-download", "sleef-x86_64-unknown-linux-gnu"]
      } else if (targetTriple === "aarch64-unknown-linux-gnu") {
        dependsOn = [
          "pytorch-cache-download",
          "sleef-x86_64-unknown-linux-gnu",
          "sleef-aarch64-unknown-linux-gnu",
        ]
      } else {
        dependsOn = "pytorch-cache-download"
      }
    }

    // Build command list
    const commands = ["set -e"]

    // PyTorch: download cache
    if (library === "pytorch") {
      commands.push(
        'buildkite-agent artifact download "pytorch.tar.gz" .',
        "bsdtar -xf pytorch.tar.gz",
      )

      // Download protobuf and SLEEF for Linux builds
      if (targetTriple === "x86_64-unknown-linux-gnu") {
        const protobufVersion = "v33.0"
        commands.push(
          `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/protobuf_${protobufVersion}_x86_64-unknown-linux-gnu.tar.gz" -o protobuf_x86_64-unknown-linux-gnu.tar.gz`,
          "mkdir -p target/x86_64-unknown-linux-gnu",
          "bsdtar -xf protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
          'buildkite-agent artifact download "target/sleef_x86_64-unknown-linux-gnu.tar.gz" .',
          "bsdtar -xf target/sleef_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
        )
      } else if (targetTriple === "aarch64-unknown-linux-gnu") {
        const protobufVersion = "v33.0"
        commands.push(
          `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/protobuf_${protobufVersion}_x86_64-unknown-linux-gnu.tar.gz" -o protobuf_x86_64-unknown-linux-gnu.tar.gz`,
          `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/protobuf_${protobufVersion}_aarch64-unknown-linux-gnu.tar.gz" -o protobuf_aarch64-unknown-linux-gnu.tar.gz`,
          "mkdir -p target/x86_64-unknown-linux-gnu",
          "bsdtar -xf protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
          "mkdir -p target/aarch64-unknown-linux-gnu",
          "bsdtar -xf protobuf_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu",
          'buildkite-agent artifact download "target/sleef_aarch64-unknown-linux-gnu.tar.gz" .',
          "bsdtar -xf target/sleef_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu",
          'buildkite-agent artifact download "target/sleef-build_x86_64-unknown-linux-gnu.tar.gz" .',
          "bsdtar -xf target/sleef-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
        )
      }
    }

    // ICU4C cross-compilation: download host build
    if (library === "icu4c" && hostArtifactName && hostTargetDir) {
      // Download the build artifact (not the release artifact)
      const buildArtifactName = hostArtifactName.replace(
        "icu4c_",
        "icu4c-build_",
      )
      commands.push(
        `buildkite-agent artifact download "target/${buildArtifactName}" .`,
        `mkdir -p target/${hostTargetDir}`,
        `bsdtar -xf target/${buildArtifactName} -C target/${hostTargetDir}`,
      )
    }

    commands.push(buildCmd)

    // Create artifacts
    if (targetTriple.includes("windows")) {
      commands.push(
        `mkdir -f target`,
        `C:\\msys2\\usr\\bin\\bash.exe -c "bsdtar --gzip --options gzip:compression-level=9 -cf target/${artifactName} -C target/${targetTriple} ${library}"`,
      )
    } else {
      commands.push(
        `bsdtar --gzip --options gzip:compression-level=9 -cf target/${artifactName} -C target/${targetTriple} ${library}`,
      )
      // For ICU4C native platforms, also create build artifact
      if (
        library === "icu4c" &&
        (targetTriple === "aarch64-apple-darwin" ||
          targetTriple === "x86_64-unknown-linux-gnu")
      ) {
        commands.push(
          `bsdtar --gzip --options gzip:compression-level=9 -cf target/${library}-build_${targetTriple}.tar.gz -C target/${targetTriple} build/icu`,
        )
      }
    }

    // Determine artifact paths
    const artifactPaths = [`target/${artifactName}`]
    if (
      library === "icu4c" &&
      (targetTriple === "aarch64-apple-darwin" ||
        targetTriple === "x86_64-unknown-linux-gnu")
    ) {
      artifactPaths.push(`target/${library}-build_${targetTriple}.tar.gz`)
    }

    buildSteps.push(
      command({
        label: `:package: ${library} ${targetTriple}`,
        key: `${library}-${targetTriple}`,
        depends_on: dependsOn,
        command: commands.join("\n"),
        agents: {
          queue,
        },
        artifact_paths: artifactPaths,
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
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin icu4c",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c-build_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin build/icu",
            ].join("\n"),
            agents: {
              queue: "macos",
            },
            artifact_paths: [
              "target/icu4c_aarch64-apple-darwin.tar.gz",
              "target/icu4c-build_aarch64-apple-darwin.tar.gz",
            ],
          }),
          command({
            label: "macOS ARM64: LibOMP",
            key: "macos-arm64-libomp",
            command: [
              "set -e",
              "divvun-actions run libomp-build aarch64-apple-darwin",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/libomp_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin libomp",
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
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin protobuf",
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
              "bsdtar -xf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-darwin.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin",
              "bsdtar -xf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "divvun-actions run pytorch-build aarch64-apple-darwin",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/pytorch_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin pytorch",
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
            depends_on: "macos-arm64-icu",
            command: [
              "set -e",
              'buildkite-agent artifact download "target/icu4c-build_aarch64-apple-darwin.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin",
              "bsdtar -xf target/icu4c-build_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "divvun-actions run icu4c-build aarch64-apple-ios",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios icu4c",
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
              "bsdtar -xf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "divvun-actions run protobuf-build aarch64-apple-ios",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/protobuf_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios protobuf",
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
              "bsdtar -xf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-darwin.tar.gz" .',
              'buildkite-agent artifact download "target/protobuf_aarch64-apple-ios.tar.gz" .',
              "mkdir -p target/aarch64-apple-darwin target/aarch64-apple-ios",
              "bsdtar -xf target/protobuf_aarch64-apple-darwin.tar.gz -C target/aarch64-apple-darwin",
              "bsdtar -xf target/protobuf_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios",
              "divvun-actions run pytorch-build aarch64-apple-ios",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/pytorch_aarch64-apple-ios.tar.gz -C target/aarch64-apple-ios pytorch",
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
            depends_on: "linux-x86_64-icu",
            command: [
              "set -e",
              'buildkite-agent artifact download "target/icu4c-build_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "bsdtar -xf target/icu4c-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "divvun-actions run icu4c-build aarch64-linux-android",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c_aarch64-linux-android.tar.gz -C target/aarch64-linux-android icu4c",
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
              "bsdtar -xf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "divvun-actions run protobuf-build aarch64-linux-android",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/protobuf_aarch64-linux-android.tar.gz -C target/aarch64-linux-android protobuf",
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
              "bsdtar -xf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              'buildkite-agent artifact download "target/protobuf_aarch64-linux-android.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu target/aarch64-linux-android",
              "bsdtar -xf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "bsdtar -xf target/protobuf_aarch64-linux-android.tar.gz -C target/aarch64-linux-android",
              "ANDROID_NDK=$ANDROID_NDK_HOME divvun-actions run pytorch-build aarch64-linux-android",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/pytorch_aarch64-linux-android.tar.gz -C target/aarch64-linux-android pytorch",
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
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu icu4c",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu build/icu",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/icu4c_x86_64-unknown-linux-gnu.tar.gz",
              "target/icu4c-build_x86_64-unknown-linux-gnu.tar.gz",
            ],
          }),
          command({
            label: "Linux x86_64: LibOMP",
            key: "linux-x86_64-libomp",
            command: [
              "set -e",
              "divvun-actions run libomp-build x86_64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/libomp_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu libomp",
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
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu protobuf",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/protobuf_x86_64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux x86_64: SLEEF",
            key: "linux-x86_64-sleef",
            command: [
              "set -e",
              "divvun-actions run sleef-build x86_64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu sleef",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu build/sleef",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/sleef_x86_64-unknown-linux-gnu.tar.gz",
              "target/sleef-build_x86_64-unknown-linux-gnu.tar.gz",
            ],
          }),
          command({
            label: "Linux x86_64: PyTorch",
            key: "linux-x86_64-pytorch",
            depends_on: [
              "linux-x86_64-protobuf",
              "linux-x86_64-sleef",
              "pytorch-cache-download",
            ],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "bsdtar -xf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "bsdtar -xf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              'buildkite-agent artifact download "target/sleef_x86_64-unknown-linux-gnu.tar.gz" .',
              "bsdtar -xf target/sleef_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "divvun-actions run pytorch-build x86_64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/pytorch_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu pytorch",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/pytorch_x86_64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux ARM64: ICU",
            key: "linux-aarch64-icu",
            depends_on: ["linux-x86_64-icu"],
            command: [
              "set -e",
              'buildkite-agent artifact download "target/icu4c-build_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "bsdtar -xf target/icu4c-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "divvun-actions run icu4c-build aarch64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu icu4c",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c-build_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu build/icu",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/icu4c_aarch64-unknown-linux-gnu.tar.gz",
              "target/icu4c-build_aarch64-unknown-linux-gnu.tar.gz",
            ],
          }),
          command({
            label: "Linux ARM64: LibOMP",
            key: "linux-aarch64-libomp",
            command: [
              "set -e",
              "divvun-actions run libomp-build aarch64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/libomp_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu libomp",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/libomp_aarch64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux ARM64: Protobuf",
            key: "linux-aarch64-protobuf",
            command: [
              "set -e",
              "divvun-actions run protobuf-build aarch64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/protobuf_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu protobuf",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/protobuf_aarch64-unknown-linux-gnu.tar.gz",
            ],
          }),
          command({
            label: "Linux ARM64: SLEEF",
            key: "linux-aarch64-sleef",
            depends_on: ["linux-x86_64-sleef"],
            command: [
              "set -e",
              'buildkite-agent artifact download "target/sleef-build_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "bsdtar -xf target/sleef-build_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              "divvun-actions run sleef-build aarch64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu sleef",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/sleef_aarch64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux ARM64: PyTorch",
            key: "linux-aarch64-pytorch",
            depends_on: [
              "linux-x86_64-protobuf",
              "linux-aarch64-protobuf",
              "linux-x86_64-sleef",
              "linux-aarch64-sleef",
              "pytorch-cache-download",
            ],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "bsdtar -xf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-gnu",
              "bsdtar -xf target/protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
              'buildkite-agent artifact download "target/protobuf_aarch64-unknown-linux-gnu.tar.gz" .',
              "mkdir -p target/aarch64-unknown-linux-gnu",
              "bsdtar -xf target/protobuf_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu",
              'buildkite-agent artifact download "target/sleef_aarch64-unknown-linux-gnu.tar.gz" .',
              "bsdtar -xf target/sleef_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu",
              "divvun-actions run pytorch-build aarch64-unknown-linux-gnu",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/pytorch_aarch64-unknown-linux-gnu.tar.gz -C target/aarch64-unknown-linux-gnu pytorch",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/pytorch_aarch64-unknown-linux-gnu.tar.gz"],
          }),
          command({
            label: "Linux x86_64 musl: ICU",
            key: "linux-x86_64-musl-icu",
            command: [
              "set -e",
              "divvun-actions run icu4c-build x86_64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl icu4c",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c-build_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl build/icu",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/icu4c_x86_64-unknown-linux-musl.tar.gz",
              "target/icu4c-build_x86_64-unknown-linux-musl.tar.gz",
            ],
          }),
          command({
            label: "Linux x86_64 musl: LibOMP",
            key: "linux-x86_64-musl-libomp",
            command: [
              "set -e",
              "divvun-actions run libomp-build x86_64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/libomp_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl libomp",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/libomp_x86_64-unknown-linux-musl.tar.gz"],
          }),
          command({
            label: "Linux x86_64 musl: Protobuf",
            key: "linux-x86_64-musl-protobuf",
            command: [
              "set -e",
              "divvun-actions run protobuf-build x86_64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/protobuf_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl protobuf",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/protobuf_x86_64-unknown-linux-musl.tar.gz"],
          }),
          command({
            label: "Linux x86_64 musl: SLEEF",
            key: "linux-x86_64-musl-sleef",
            command: [
              "set -e",
              "divvun-actions run sleef-build x86_64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl sleef",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef-build_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl build/sleef",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/sleef_x86_64-unknown-linux-musl.tar.gz",
              "target/sleef-build_x86_64-unknown-linux-musl.tar.gz",
            ],
          }),
          command({
            label: "Linux x86_64 musl: PyTorch",
            key: "linux-x86_64-musl-pytorch",
            depends_on: [
              "linux-x86_64-musl-protobuf",
              "linux-x86_64-musl-sleef",
              "pytorch-cache-download",
            ],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "bsdtar -xf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-musl.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-musl",
              "bsdtar -xf target/protobuf_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl",
              'buildkite-agent artifact download "target/sleef_x86_64-unknown-linux-musl.tar.gz" .',
              "bsdtar -xf target/sleef_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl",
              "divvun-actions run pytorch-build x86_64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/pytorch_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl pytorch",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/pytorch_x86_64-unknown-linux-musl.tar.gz"],
          }),
          command({
            label: "Linux ARM64 musl: ICU",
            key: "linux-aarch64-musl-icu",
            depends_on: ["linux-x86_64-musl-icu"],
            command: [
              "set -e",
              'buildkite-agent artifact download "target/icu4c-build_x86_64-unknown-linux-musl.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-musl",
              "bsdtar -xf target/icu4c-build_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl",
              "divvun-actions run icu4c-build aarch64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl icu4c",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/icu4c-build_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl build/icu",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/icu4c_aarch64-unknown-linux-musl.tar.gz",
              "target/icu4c-build_aarch64-unknown-linux-musl.tar.gz",
            ],
          }),
          command({
            label: "Linux ARM64 musl: LibOMP",
            key: "linux-aarch64-musl-libomp",
            command: [
              "set -e",
              "divvun-actions run libomp-build aarch64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/libomp_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl libomp",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/libomp_aarch64-unknown-linux-musl.tar.gz"],
          }),
          command({
            label: "Linux ARM64 musl: Protobuf",
            key: "linux-aarch64-musl-protobuf",
            command: [
              "set -e",
              "divvun-actions run protobuf-build aarch64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/protobuf_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl protobuf",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: [
              "target/protobuf_aarch64-unknown-linux-musl.tar.gz",
            ],
          }),
          command({
            label: "Linux ARM64 musl: SLEEF",
            key: "linux-aarch64-musl-sleef",
            depends_on: ["linux-x86_64-musl-sleef"],
            command: [
              "set -e",
              'buildkite-agent artifact download "target/sleef-build_x86_64-unknown-linux-musl.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-musl",
              "bsdtar -xf target/sleef-build_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl",
              "divvun-actions run sleef-build aarch64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/sleef_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl sleef",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/sleef_aarch64-unknown-linux-musl.tar.gz"],
          }),
          command({
            label: "Linux ARM64 musl: PyTorch",
            key: "linux-aarch64-musl-pytorch",
            depends_on: [
              "linux-x86_64-musl-protobuf",
              "linux-aarch64-musl-protobuf",
              "linux-x86_64-musl-sleef",
              "linux-aarch64-musl-sleef",
              "pytorch-cache-download",
            ],
            command: [
              "set -e",
              'buildkite-agent artifact download "pytorch.tar.gz" .',
              "bsdtar -xf pytorch.tar.gz",
              'buildkite-agent artifact download "target/protobuf_x86_64-unknown-linux-musl.tar.gz" .',
              "mkdir -p target/x86_64-unknown-linux-musl",
              "bsdtar -xf target/protobuf_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl",
              'buildkite-agent artifact download "target/protobuf_aarch64-unknown-linux-musl.tar.gz" .',
              "mkdir -p target/aarch64-unknown-linux-musl",
              "bsdtar -xf target/protobuf_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl",
              'buildkite-agent artifact download "target/sleef_aarch64-unknown-linux-musl.tar.gz" .',
              "bsdtar -xf target/sleef_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl",
              'buildkite-agent artifact download "target/sleef-build_x86_64-unknown-linux-musl.tar.gz" .',
              "bsdtar -xf target/sleef-build_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl",
              "divvun-actions run pytorch-build aarch64-unknown-linux-musl",
              "bsdtar --gzip --options gzip:compression-level=9 -cf target/pytorch_aarch64-unknown-linux-musl.tar.gz -C target/aarch64-unknown-linux-musl pytorch",
            ].join("\n"),
            agents: {
              queue: "linux",
            },
            artifact_paths: ["target/pytorch_aarch64-unknown-linux-musl.tar.gz"],
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
              "mkdir -p target",
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
