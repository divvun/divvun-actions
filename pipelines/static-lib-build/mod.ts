import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"

const PYTORCH_VERSION = "v2.8.0"

type LibraryType = "icu4c" | "libomp" | "protobuf" | "sleef" | "pytorch"

// ============================================================================
// CONFIGURATION
// ============================================================================

interface CrossCompilationRule {
  hostTarget: string
  hostArtifacts?: string[] // Specific artifacts to download (e.g., for PyTorch)
}

interface LibraryConfig {
  platforms: string[]
  createsBuildArtifacts?: boolean // Whether this library creates -build artifacts for cross-compilation
  crossCompilationRules?: Record<string, CrossCompilationRule>
  defaultVersions?: { protobuf?: string; sleef?: string } // For PyTorch dependencies
}

const LIBRARY_CONFIGS: Record<LibraryType, LibraryConfig> = {
  icu4c: {
    platforms: [
      "aarch64-apple-darwin",
      "aarch64-apple-ios",
      "aarch64-linux-android",
      "aarch64-unknown-linux-gnu",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
      "x86_64-pc-windows-msvc",
    ],
    createsBuildArtifacts: true,
    crossCompilationRules: {
      "aarch64-apple-ios": { hostTarget: "aarch64-apple-darwin" },
      "aarch64-linux-android": { hostTarget: "x86_64-unknown-linux-gnu" },
      "aarch64-unknown-linux-gnu": { hostTarget: "x86_64-unknown-linux-gnu" },
      "aarch64-unknown-linux-musl": { hostTarget: "x86_64-unknown-linux-musl" },
    },
  },
  libomp: {
    platforms: [
      "aarch64-apple-darwin",
      "aarch64-unknown-linux-gnu",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
    ],
    createsBuildArtifacts: false,
  },
  protobuf: {
    platforms: [
      "aarch64-apple-darwin",
      "aarch64-apple-ios",
      "aarch64-linux-android",
      "aarch64-unknown-linux-gnu",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
    ],
    createsBuildArtifacts: true,
  },
  sleef: {
    platforms: [
      "aarch64-unknown-linux-gnu",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
    ],
    createsBuildArtifacts: true,
    crossCompilationRules: {
      "aarch64-unknown-linux-gnu": { hostTarget: "x86_64-unknown-linux-gnu" },
      "aarch64-unknown-linux-musl": { hostTarget: "x86_64-unknown-linux-musl" },
    },
  },
  pytorch: {
    platforms: [
      "aarch64-apple-darwin",
      "aarch64-apple-ios",
      "aarch64-linux-android",
      "aarch64-unknown-linux-gnu",
      "aarch64-unknown-linux-musl",
      "x86_64-unknown-linux-gnu",
      "x86_64-unknown-linux-musl",
    ],
    createsBuildArtifacts: false,
    defaultVersions: {
      protobuf: "v33.0",
      sleef: "v3.9.0",
    },
  },
}

// ============================================================================
// ORIGINAL CODE
// ============================================================================

interface ReleaseTag {
  library: LibraryType
  version: string
}

function parseReleaseTag(tag: string): ReleaseTag | null {
  // Match tags like: icu4c/v77.1, libomp/v21.1.4, protobuf/v33.0, sleef/v3.9.0, pytorch/v2.8.0
  const match = tag.match(/^(icu4c|libomp|protobuf|sleef|pytorch)\/v?(.+)$/)
  if (!match) return null

  return {
    library: match[1] as LibraryType,
    version: match[2].startsWith("v") ? match[2] : `v${match[2]}`,
  }
}

function getLibraryPlatforms(library: LibraryType): string[] {
  return LIBRARY_CONFIGS[library].platforms
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

// Helper to get cross-compilation info from configuration
function getCrossCompilationInfo(library: LibraryType, targetTriple: string) {
  const config = LIBRARY_CONFIGS[library]
  const rule = config.crossCompilationRules?.[targetTriple]

  if (!rule) {
    return {
      dependsOn: undefined,
      hostArtifactName: undefined,
      hostTargetDir: undefined,
    }
  }

  const hostTarget = rule.hostTarget
  const stepKey = `${library}-${hostTarget.replace(/-/g, "-")}`
  const createsBuild = config.createsBuildArtifacts

  return {
    dependsOn: stepKey,
    hostArtifactName: createsBuild
      ? `${library}-build_${hostTarget}.tar.gz`
      : `${library}_${hostTarget}.tar.gz`,
    hostTargetDir: hostTarget,
  }
}

// Helper to determine if this build should create a -build artifact (for use as host build in cross-compilation)
function shouldCreateBuildArtifact(
  library: LibraryType,
  targetTriple: string,
): boolean {
  const config = LIBRARY_CONFIGS[library]

  // Only libraries marked as creating build artifacts do so
  if (!config.createsBuildArtifacts) {
    return false
  }

  // Check if this target is used as a host build by any cross-compilation rule
  for (const [_, rule] of Object.entries(config.crossCompilationRules || {})) {
    if (rule.hostTarget === targetTriple) {
      return true
    }
  }

  return false
}

// ============================================================================
// BUILD STEP FACTORY
// ============================================================================

interface BuildStepOptions {
  library: LibraryType
  target: string
  version?: string
  extraDependencies?: string[]
  priority?: number
  largeAgent?: boolean
  env?: Record<string, string>
  commandPrefix?: string
  isReleaseBuild?: boolean // For release builds, deps are downloaded from GitHub releases, not artifacts
}

// Helper to get PyTorch dependencies on protobuf, sleef, and libomp build steps
function getPyTorchDependencies(targetTriple: string): string[] {
  if (!targetTriple.includes("linux") || targetTriple.includes("android")) {
    return []
  }

  const deps: string[] = []

  // Target libomp
  deps.push(`libomp-${targetTriple}`)

  // Target protobuf
  deps.push(`protobuf-${targetTriple}`)

  // Target sleef
  deps.push(`sleef-${targetTriple}`)

  // Cross-compilation needs host builds
  if (targetTriple === "aarch64-unknown-linux-gnu") {
    deps.push(`protobuf-x86_64-unknown-linux-gnu`)
    deps.push(`sleef-x86_64-unknown-linux-gnu`)
  } else if (targetTriple === "aarch64-unknown-linux-musl") {
    deps.push(`protobuf-x86_64-unknown-linux-musl`)
    deps.push(`sleef-x86_64-unknown-linux-musl`)
  }
  // x86_64-unknown-linux-musl and x86_64-unknown-linux-gnu are native builds - no extra deps

  return deps
}

// Helper to create PyTorch-specific setup commands (protobuf + SLEEF downloads)
function createPyTorchSetupCommands(
  targetTriple: string,
  isReleaseBuild: boolean,
): string[] {
  const config = LIBRARY_CONFIGS.pytorch
  const protobufVersion = config.defaultVersions!.protobuf!
  const sleefVersion = config.defaultVersions!.sleef!
  const commands: string[] = []

  // Download PyTorch cache
  commands.push(
    'buildkite-agent artifact download "pytorch.tar.gz" .',
    "bsdtar -xf pytorch.tar.gz",
  )

  // For Linux builds, download protobuf and SLEEF dependencies
  if (targetTriple.includes("linux") && !targetTriple.includes("android")) {
    // For cross-compilation (aarch64), need host protobuf from GitHub release
    if (targetTriple === "aarch64-unknown-linux-gnu") {
      commands.push(
        `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/protobuf_${protobufVersion}_x86_64-unknown-linux-gnu.tar.gz" -o protobuf_x86_64-unknown-linux-gnu.tar.gz`,
        "mkdir -p target/x86_64-unknown-linux-gnu",
        "bsdtar -xf protobuf_x86_64-unknown-linux-gnu.tar.gz -C target/x86_64-unknown-linux-gnu",
      )
    } else if (targetTriple === "aarch64-unknown-linux-musl") {
      commands.push(
        `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/protobuf_${protobufVersion}_x86_64-unknown-linux-musl.tar.gz" -o protobuf_x86_64-unknown-linux-musl.tar.gz`,
        "mkdir -p target/x86_64-unknown-linux-musl",
        "bsdtar -xf protobuf_x86_64-unknown-linux-musl.tar.gz -C target/x86_64-unknown-linux-musl",
      )
    }

    // Download target protobuf - from GitHub releases for release builds, artifacts otherwise
    if (isReleaseBuild) {
      commands.push(
        `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/protobuf_${protobufVersion}_${targetTriple}.tar.gz" -o protobuf_${targetTriple}.tar.gz`,
        `mkdir -p target/${targetTriple}`,
        `bsdtar -xf protobuf_${targetTriple}.tar.gz -C target/${targetTriple}`,
      )
    } else {
      commands.push(
        `buildkite-agent artifact download "target/protobuf_${targetTriple}.tar.gz" .`,
        `mkdir -p target/${targetTriple}`,
        `bsdtar -xf target/protobuf_${targetTriple}.tar.gz -C target/${targetTriple}`,
      )
    }

    // Download target SLEEF - from GitHub releases for release builds, artifacts otherwise
    if (isReleaseBuild) {
      commands.push(
        `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/sleef%2F${sleefVersion}/sleef_${sleefVersion}_${targetTriple}.tar.gz" -o sleef_${targetTriple}.tar.gz`,
        `bsdtar -xf sleef_${targetTriple}.tar.gz -C target/${targetTriple}`,
      )
    } else {
      commands.push(
        `buildkite-agent artifact download "target/sleef_${targetTriple}.tar.gz" .`,
        `bsdtar -xf target/sleef_${targetTriple}.tar.gz -C target/${targetTriple}`,
      )
    }

    // For cross-compilation, also need host SLEEF build tools
    if (targetTriple === "aarch64-unknown-linux-gnu") {
      const hostTriple = "x86_64-unknown-linux-gnu"
      if (isReleaseBuild) {
        commands.push(
          `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/sleef%2F${sleefVersion}/sleef-build_${sleefVersion}_${hostTriple}.tar.gz" -o sleef-build_${hostTriple}.tar.gz`,
          `mkdir -p build/${hostTriple}`,
          `bsdtar -xf sleef-build_${hostTriple}.tar.gz -C build/${hostTriple}`,
        )
      } else {
        commands.push(
          `buildkite-agent artifact download "target/sleef-build_${hostTriple}.tar.gz" .`,
          `mkdir -p build/${hostTriple}`,
          `bsdtar -xf target/sleef-build_${hostTriple}.tar.gz -C build/${hostTriple}`,
        )
      }
    } else if (targetTriple === "aarch64-unknown-linux-musl") {
      const hostTriple = "x86_64-unknown-linux-musl"
      if (isReleaseBuild) {
        commands.push(
          `curl -fsSL "https://github.com/divvun/static-lib-build/releases/download/sleef%2F${sleefVersion}/sleef-build_${sleefVersion}_${hostTriple}.tar.gz" -o sleef-build_${hostTriple}.tar.gz`,
          `mkdir -p build/${hostTriple}`,
          `bsdtar -xf sleef-build_${hostTriple}.tar.gz -C build/${hostTriple}`,
        )
      } else {
        commands.push(
          `buildkite-agent artifact download "target/sleef-build_${hostTriple}.tar.gz" .`,
          `mkdir -p build/${hostTriple}`,
          `bsdtar -xf target/sleef-build_${hostTriple}.tar.gz -C build/${hostTriple}`,
        )
      }
    }
    // x86_64 targets (gnu and musl) are native builds - no host SLEEF needed
  }

  return commands
}

function createLibraryBuildStep(options: BuildStepOptions): CommandStep {
  const {
    library,
    target: targetTriple,
    version,
    extraDependencies,
    priority,
    largeAgent,
    isReleaseBuild,
  } = options

  // Determine queue based on platform
  // musl targets go to dedicated Alpine agents
  const queue = targetTriple.includes("windows")
    ? "windows"
    : targetTriple.includes("-musl")
    ? "alpine"
    : targetTriple.includes("linux") || targetTriple.includes("android")
    ? "linux"
    : "macos"

  const buildCmd = version
    ? `divvun-actions run ${library}-build ${targetTriple} ${version}`
    : `divvun-actions run ${library}-build ${targetTriple}`

  // Get cross-compilation dependencies
  const { dependsOn: crossCompDep, hostArtifactName, hostTargetDir } =
    getCrossCompilationInfo(library, targetTriple)

  // Get PyTorch-specific dependencies (protobuf and sleef)
  // For release builds, these are downloaded from GitHub releases, not artifacts
  const pytorchDeps = library === "pytorch" && !isReleaseBuild
    ? getPyTorchDependencies(targetTriple)
    : []

  // Combine all dependencies
  const allExtraDeps = [...(extraDependencies || []), ...pytorchDeps]
  let dependsOn: string | string[] | undefined = crossCompDep
  if (allExtraDeps.length > 0) {
    if (crossCompDep) {
      dependsOn = [crossCompDep, ...allExtraDeps]
    } else {
      dependsOn = allExtraDeps.length === 1 ? allExtraDeps[0] : allExtraDeps
    }
  }

  // Build commands array
  const commands: string[] = ["set -e"]

  // PyTorch has special setup requirements
  if (library === "pytorch") {
    commands.push(...createPyTorchSetupCommands(targetTriple, !!isReleaseBuild))
  }

  // Download and extract host build artifacts if cross-compiling
  if (hostArtifactName && hostTargetDir) {
    commands.push(
      `buildkite-agent artifact download "target/${hostArtifactName}" .`,
      `mkdir -p build/${hostTargetDir}`,
      `bsdtar -xf target/${hostArtifactName} -C build/${hostTargetDir}`,
    )
  }

  commands.push(
    options.commandPrefix ? `${options.commandPrefix} ${buildCmd}` : buildCmd,
  )

  // Create artifacts
  const artifactName = `${library}_${targetTriple}.tar.gz`
  if (targetTriple.includes("windows")) {
    commands.push(
      `mkdir -f target`,
      `C:\\msys2\\usr\\bin\\bash.exe -c "bsdtar --gzip --options gzip:compression-level=9 -cf target/${artifactName} -C target/${targetTriple} ${library}"`,
    )
  } else {
    commands.push(
      `bsdtar --gzip --options gzip:compression-level=9 -cf target/${artifactName} -C target/${targetTriple} ${library}`,
    )
    // Create build artifact if this target is used as a host build
    if (shouldCreateBuildArtifact(library, targetTriple)) {
      const buildDirName = library === "icu4c" ? "icu" : library
      commands.push(
        `bsdtar --gzip --options gzip:compression-level=9 -cf target/${library}-build_${targetTriple}.tar.gz -C build/${targetTriple} ${buildDirName}`,
      )
    }
  }

  // Determine artifact paths
  const artifactPaths = [`target/${artifactName}`]
  if (shouldCreateBuildArtifact(library, targetTriple)) {
    artifactPaths.push(`target/${library}-build_${targetTriple}.tar.gz`)
  }

  const step: CommandStep = {
    label: `:package: ${library} ${targetTriple}`,
    key: `${library}-${targetTriple}`,
    depends_on: dependsOn,
    command: commands.join("\n"),
    agents: largeAgent && queue === "linux"
      ? { queue, size: "large" }
      : { queue },
    artifact_paths: artifactPaths,
  }

  if (priority !== undefined) {
    step.priority = priority
  }

  if (options.env) {
    step.env = options.env
  }

  return command(step)
}

// ============================================================================
// ORIGINAL GENERATERELEASEPIPELINE (TO BE REFACTORED)
// ============================================================================

function generateReleasePipeline(release: ReleaseTag): BuildkitePipeline {
  const { library, version } = release
  const platforms = getLibraryPlatforms(library)

  const pipeline: BuildkitePipeline = {
    steps: [],
  }

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

  const buildSteps: CommandStep[] = []

  for (const targetTriple of platforms) {
    const options: BuildStepOptions = {
      library,
      target: targetTriple,
      version,
      isReleaseBuild: true,
    }

    if (library === "pytorch") {
      options.extraDependencies = ["pytorch-cache-download"]
      options.env = { MAX_JOBS: "2" }
      if (targetTriple.includes("-musl")) {
        options.priority = 1
        options.largeAgent = true
      }
    }

    buildSteps.push(createLibraryBuildStep(options))
  }

  pipeline.steps.push({
    group: `:package: Build ${library} ${version}`,
    key: `build-${library}`,
    steps: buildSteps,
  })

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
  const releaseTag = builder.env.tag ? parseReleaseTag(builder.env.tag) : null

  if (releaseTag) {
    return generateReleasePipeline(releaseTag)
  }

  type LibBuild = {
    lib: LibraryType
    target: string
    deps?: string[]
    env?: Record<string, string>
    commandPrefix?: string
  }

  const macosBuilds: LibBuild[] = [
    { lib: "icu4c", target: "aarch64-apple-darwin" },
    { lib: "libomp", target: "aarch64-apple-darwin" },
    { lib: "protobuf", target: "aarch64-apple-darwin" },
    {
      lib: "pytorch",
      target: "aarch64-apple-darwin",
      deps: ["pytorch-cache-download"],
      env: { MAX_JOBS: "2" },
    },
  ]

  const iosBuilds: LibBuild[] = [
    { lib: "icu4c", target: "aarch64-apple-ios" },
    { lib: "protobuf", target: "aarch64-apple-ios" },
    {
      lib: "pytorch",
      target: "aarch64-apple-ios",
      deps: ["pytorch-cache-download"],
      env: { MAX_JOBS: "2" },
    },
  ]

  const androidBuilds: LibBuild[] = [
    { lib: "icu4c", target: "aarch64-linux-android" },
    { lib: "protobuf", target: "aarch64-linux-android" },
    {
      lib: "pytorch",
      target: "aarch64-linux-android",
      deps: ["pytorch-cache-download"],
      commandPrefix: "ANDROID_NDK=$ANDROID_NDK_HOME",
      env: { MAX_JOBS: "2" },
    },
  ]

  const linuxGnuX64Builds: LibBuild[] = [
    { lib: "icu4c", target: "x86_64-unknown-linux-gnu" },
    { lib: "libomp", target: "x86_64-unknown-linux-gnu" },
    { lib: "protobuf", target: "x86_64-unknown-linux-gnu" },
    { lib: "sleef", target: "x86_64-unknown-linux-gnu" },
    {
      lib: "pytorch",
      target: "x86_64-unknown-linux-gnu",
      deps: ["pytorch-cache-download"],
      env: { MAX_JOBS: "2" },
    },
  ]

  const linuxGnuArm64Builds: LibBuild[] = [
    { lib: "icu4c", target: "aarch64-unknown-linux-gnu" },
    { lib: "libomp", target: "aarch64-unknown-linux-gnu" },
    { lib: "protobuf", target: "aarch64-unknown-linux-gnu" },
    { lib: "sleef", target: "aarch64-unknown-linux-gnu" },
    {
      lib: "pytorch",
      target: "aarch64-unknown-linux-gnu",
      deps: ["pytorch-cache-download"],
      env: { MAX_JOBS: "2" },
    },
  ]

  const linuxMuslX64Builds: LibBuild[] = [
    { lib: "icu4c", target: "x86_64-unknown-linux-musl" },
    { lib: "libomp", target: "x86_64-unknown-linux-musl" },
    { lib: "protobuf", target: "x86_64-unknown-linux-musl" },
    { lib: "sleef", target: "x86_64-unknown-linux-musl" },
    {
      lib: "pytorch",
      target: "x86_64-unknown-linux-musl",
      deps: ["pytorch-cache-download"],
      env: { MAX_JOBS: "2" },
    },
  ]

  const linuxMuslArm64Builds: LibBuild[] = [
    { lib: "icu4c", target: "aarch64-unknown-linux-musl" },
    { lib: "libomp", target: "aarch64-unknown-linux-musl" },
    { lib: "protobuf", target: "aarch64-unknown-linux-musl" },
    { lib: "sleef", target: "aarch64-unknown-linux-musl" },
    {
      lib: "pytorch",
      target: "aarch64-unknown-linux-musl",
      deps: ["pytorch-cache-download"],
      env: { MAX_JOBS: "2" },
    },
  ]

  const windowsBuilds: LibBuild[] = [
    {
      lib: "icu4c",
      target: "x86_64-pc-windows-msvc",
      env: { MSYSTEM: "CLANG64" },
    },
  ]

  const pipeline: BuildkitePipeline = {
    env: {
      PYTORCH_VERSION,
    },
    steps: [
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
        steps: macosBuilds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
          })
        ),
      },
      {
        group: ":iphone: iOS Builds",
        steps: iosBuilds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
          })
        ),
      },
      {
        group: ":android: Android Builds",
        steps: androidBuilds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
          })
        ),
      },
      {
        group: ":linux: Linux GNU x86_64 Builds",
        steps: linuxGnuX64Builds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
          })
        ),
      },
      {
        group: ":linux: Linux GNU ARM64 Builds",
        steps: linuxGnuArm64Builds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
          })
        ),
      },
      {
        group: ":linux: Linux musl x86_64 Builds",
        steps: linuxMuslX64Builds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
            priority: b.lib === "pytorch" ? 1 : undefined,
            largeAgent: b.lib === "pytorch",
          })
        ),
      },
      {
        group: ":linux: Linux musl ARM64 Builds",
        steps: linuxMuslArm64Builds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
            priority: b.lib === "pytorch" ? 1 : undefined,
            largeAgent: b.lib === "pytorch",
          })
        ),
      },
      {
        group: ":windows: Windows Builds",
        steps: windowsBuilds.map((b) =>
          createLibraryBuildStep({
            library: b.lib,
            target: b.target,
            extraDependencies: b.deps,
            env: b.env,
            commandPrefix: b.commandPrefix,
          })
        ),
      },
    ],
  }

  return pipeline
}
