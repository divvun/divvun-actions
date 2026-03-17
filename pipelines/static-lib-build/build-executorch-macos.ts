import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

interface BuildExecutorchMacosOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

export async function buildExecutorchMacos(
  options: BuildExecutorchMacosOptions,
) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
  } = options

  logger.info("Building ExecuTorch for macOS")

  const repoRoot = Deno.cwd()
  const executorchRoot = path.join(repoRoot, "executorch")

  // Detect host architecture
  const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64"
  logger.info(`Detected host architecture: ${hostArch}`)

  // Determine brew prefix
  const brewPrefix = hostArch === "arm64" ? "/opt/homebrew" : "/usr/local"
  const ninjaPath = `${brewPrefix}/bin/ninja`
  const cmakePath = `${brewPrefix}/bin/cmake`

  // Check for Python venv
  const venvPath = path.join(executorchRoot, ".venv")
  const pythonPath = path.join(venvPath, "bin/python")

  try {
    await Deno.stat(venvPath)
  } catch {
    logger.info("No .venv found, creating one with uv...")
    await builder.exec("uv", ["venv"], { cwd: executorchRoot })
  }

  logger.info(`Using Python: ${pythonPath}`)

  // Install Python dependencies
  logger.info("Installing Python dependencies")
  await builder.exec(
    "uv",
    [
      "pip",
      "install",
      "torch",
      "torchvision",
      "pyyaml",
      "ruamel.yaml",
      "flatbuffers",
      "packaging",
    ],
    { cwd: executorchRoot },
  )

  // Determine target triple
  const targetTriple = target
  const hostTriple = hostArch === "arm64"
    ? "aarch64-apple-darwin"
    : "x86_64-apple-darwin"

  const isCrossCompile = targetTriple !== hostTriple
  if (isCrossCompile) {
    logger.info(`Cross-compiling: ${hostTriple} -> ${targetTriple}`)
  }

  // Set up directories
  const installPrefix = path.join(repoRoot, `target/${targetTriple}/executorch`)
  const buildRoot = path.join(repoRoot, `build/${targetTriple}/executorch`)

  if (clean) {
    logger.info("Cleaning build and install directories...")
    try {
      await Deno.remove(buildRoot, { recursive: true })
    } catch {
      // Ignore if doesn't exist
    }
    try {
      await Deno.remove(installPrefix, { recursive: true })
    } catch {
      // Ignore if doesn't exist
    }
  }

  await Deno.mkdir(buildRoot, { recursive: true })

  // Prepare CMake arguments
  const cmakeArgs: string[] = []

  // Use Ninja
  cmakeArgs.push("-GNinja")
  cmakeArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninjaPath}`)

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // Cross-compilation: Set target architecture
  if (isCrossCompile) {
    if (targetTriple === "x86_64-apple-darwin") {
      cmakeArgs.push("-DCMAKE_OSX_ARCHITECTURES=x86_64")
      logger.info(
        "Setting CMAKE_OSX_ARCHITECTURES=x86_64 for cross-compilation",
      )
    } else if (targetTriple === "aarch64-apple-darwin") {
      cmakeArgs.push("-DCMAKE_OSX_ARCHITECTURES=arm64")
      logger.info("Setting CMAKE_OSX_ARCHITECTURES=arm64 for cross-compilation")
    }
  }

  // ExecuTorch build flags
  cmakeArgs.push("-DEXECUTORCH_BUILD_XNNPACK=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_COREML=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXECUTOR_RUNNER=OFF")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_DATA_LOADER=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_FLAT_TENSOR=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_MODULE=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_NAMED_DATA_MAP=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_TENSOR=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_PORTABLE_OPS=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_KERNELS_OPTIMIZED=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_KERNELS_QUANTIZED=ON")

  // Verbose
  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=1")
  }

  // Display build configuration
  logger.info("")
  logger.info("=== macOS Build Configuration ===")
  logger.info(`Target triple:      ${targetTriple}`)
  logger.info(`Build type:         ${buildType}`)
  logger.info(`Python:             ${pythonPath}`)
  logger.info(`Build directory:    ${buildRoot}`)
  logger.info(`Install directory:  ${installPrefix}`)
  logger.info("====================================")
  logger.info("")

  // Build environment with venv activated
  const venvBinPath = path.join(venvPath, "bin")
  const currentPath = Deno.env.get("PATH") || ""
  const buildEnv: Record<string, string> = {
    ...Object.fromEntries(Object.entries(Deno.env.toObject())),
    CC: "clang",
    CXX: "clang++",
    MACOSX_DEPLOYMENT_TARGET: "11.0",
    CMAKE_MAKE_PROGRAM: ninjaPath,
    PATH: `${venvBinPath}:${currentPath}`,
    VIRTUAL_ENV: venvPath,
  }

  logger.info(`Using venv: ${venvPath}`)

  // Run CMake configuration
  logger.info("Running CMake configuration")
  await builder.exec(cmakePath, ["-B", buildRoot, ...cmakeArgs], {
    cwd: executorchRoot,
    env: buildEnv,
  })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    maxJobs = (await builder.output("sysctl", ["-n", "hw.ncpu"])).stdout.trim()
  }

  // Build and install
  logger.info(`Building ExecuTorch (${maxJobs} parallel jobs)`)
  await builder.exec(
    cmakePath,
    ["--build", buildRoot, "--target", "install", "-j", maxJobs],
    { cwd: executorchRoot, env: buildEnv },
  )

  logger.info("")
  logger.info("macOS build completed successfully!")
  logger.info("")
  logger.info(`Target: ${targetTriple}`)
  logger.info("")
  logger.info("Library files:")
  logger.info(`  ${installPrefix}/lib/`)
  logger.info("")
  logger.info("Header files:")
  logger.info(`  ${installPrefix}/include/`)
  logger.info("")
}
