import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"
type AndroidAbi = "arm64-v8a" | "armeabi-v7a" | "x86_64" | "x86"

interface BuildExecutorchAndroidOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
  abi?: AndroidAbi
  apiLevel?: number
}

function abiToTargetTriple(abi: AndroidAbi): string {
  switch (abi) {
    case "arm64-v8a":
      return "aarch64-linux-android"
    case "armeabi-v7a":
      return "armv7-linux-androideabi"
    case "x86_64":
      return "x86_64-linux-android"
    case "x86":
      return "i686-linux-android"
  }
}

export async function buildExecutorchAndroid(
  options: BuildExecutorchAndroidOptions,
) {
  const {
    buildType = "Release",
    clean = true,
    verbose = false,
    abi = "arm64-v8a",
    apiLevel = 26,
  } = options

  logger.info(`Building ExecuTorch for Android (${abi})`)

  const repoRoot = Deno.cwd()
  const executorchRoot = path.join(repoRoot, "executorch")

  // Find Android NDK
  const androidNdk = Deno.env.get("ANDROID_NDK") ||
    Deno.env.get("ANDROID_NDK_HOME")
  if (!androidNdk) {
    throw new Error(
      "ANDROID_NDK or ANDROID_NDK_HOME environment variable must be set",
    )
  }
  logger.info(`Using Android NDK: ${androidNdk}`)

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
  const targetTriple = abiToTargetTriple(abi)

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

  // Android toolchain
  const toolchainFile = path.join(
    androidNdk,
    "build/cmake/android.toolchain.cmake",
  )
  cmakeArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`)
  cmakeArgs.push(`-DANDROID_ABI=${abi}`)
  cmakeArgs.push(`-DANDROID_PLATFORM=android-${apiLevel}`)

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // ExecuTorch build flags
  cmakeArgs.push("-DEXECUTORCH_BUILD_XNNPACK=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_VULKAN=ON")
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
  logger.info("=== Android Build Configuration ===")
  logger.info(`Target triple:      ${targetTriple}`)
  logger.info(`Android ABI:        ${abi}`)
  logger.info(`API Level:          ${apiLevel}`)
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
    PATH: `${venvBinPath}:${currentPath}`,
    VIRTUAL_ENV: venvPath,
  }

  logger.info(`Using venv: ${venvPath}`)

  // Run CMake configuration
  logger.info("Running CMake configuration")
  await builder.exec("cmake", ["-B", buildRoot, ...cmakeArgs], {
    cwd: executorchRoot,
    env: buildEnv,
  })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    try {
      maxJobs = (await builder.output("nproc", [])).stdout.trim()
    } catch {
      maxJobs = (
        await builder.output("sysctl", ["-n", "hw.ncpu"])
      ).stdout.trim()
    }
  }

  // Build and install
  logger.info(`Building ExecuTorch (${maxJobs} parallel jobs)`)
  await builder.exec(
    "cmake",
    ["--build", buildRoot, "--target", "install", "-j", maxJobs],
    { cwd: executorchRoot, env: buildEnv },
  )

  logger.info("")
  logger.info("Android build completed successfully!")
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
