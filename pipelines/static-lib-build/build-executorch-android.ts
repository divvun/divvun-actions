import * as path from "@std/path"
import * as builder from "~/builder.ts"

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

  console.log(`Building ExecuTorch for Android (${abi})`)

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
  console.log(`Using Android NDK: ${androidNdk}`)

  // Check for Python venv
  const venvPath = path.join(executorchRoot, ".venv")
  const pythonPath = path.join(venvPath, "bin/python")

  try {
    await Deno.stat(venvPath)
  } catch {
    console.log("No .venv found, creating one with uv...")
    await builder.exec("uv", ["venv"], { cwd: executorchRoot })
  }

  console.log(`Using Python: ${pythonPath}`)

  // Install Python dependencies
  console.log("Installing Python dependencies")
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
    console.log("Cleaning build and install directories...")
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

  // Apply patch
  console.log("Applying patch")
  const patchPath = path.join(
    import.meta.dirname!,
    "patches/executorch/windows.patch",
  )
  await builder.exec("patch", ["-p1", "-i", patchPath], {
    cwd: executorchRoot,
  })

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
  console.log("")
  console.log("=== Android Build Configuration ===")
  console.log(`Target triple:      ${targetTriple}`)
  console.log(`Android ABI:        ${abi}`)
  console.log(`API Level:          ${apiLevel}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Python:             ${pythonPath}`)
  console.log(`Build directory:    ${buildRoot}`)
  console.log(`Install directory:  ${installPrefix}`)
  console.log("====================================")
  console.log("")

  // Build environment with venv activated
  const venvBinPath = path.join(venvPath, "bin")
  const currentPath = Deno.env.get("PATH") || ""
  const buildEnv: Record<string, string> = {
    ...Object.fromEntries(Object.entries(Deno.env.toObject())),
    PATH: `${venvBinPath}:${currentPath}`,
    VIRTUAL_ENV: venvPath,
  }

  console.log(`Using venv: ${venvPath}`)

  // Run CMake configuration
  console.log("Running CMake configuration")
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
  console.log(`Building ExecuTorch (${maxJobs} parallel jobs)`)
  await builder.exec(
    "cmake",
    ["--build", buildRoot, "--target", "install", "-j", maxJobs],
    { cwd: executorchRoot, env: buildEnv },
  )

  console.log("")
  console.log("Android build completed successfully!")
  console.log("")
  console.log(`Target: ${targetTriple}`)
  console.log("")
  console.log("Library files:")
  console.log(`  ${installPrefix}/lib/`)
  console.log("")
  console.log("Header files:")
  console.log(`  ${installPrefix}/include/`)
  console.log("")
}
