import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

interface BuildExecutorchIosOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
  simulator?: "arm64" | "x86_64"
}

export async function buildExecutorchIos(options: BuildExecutorchIosOptions) {
  const {
    buildType = "Release",
    clean = true,
    verbose = false,
    simulator,
  } = options

  console.log("Building ExecuTorch for iOS")

  const repoRoot = Deno.cwd()
  const executorchRoot = path.join(repoRoot, "executorch")

  // Detect host architecture
  const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64"
  console.log(`Detected host architecture: ${hostArch}`)

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

  // Determine iOS platform and target
  let iosPlatform: string
  let targetTriple: string

  if (simulator === "arm64") {
    iosPlatform = "SIMULATORARM64"
    targetTriple = "aarch64-apple-ios-sim"
  } else if (simulator === "x86_64") {
    iosPlatform = "SIMULATOR64"
    targetTriple = "x86_64-apple-ios-sim"
  } else {
    iosPlatform = "OS64"
    targetTriple = "aarch64-apple-ios"
  }

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

  // Prepare CMake arguments
  const cmakeArgs: string[] = []

  // Use Ninja
  cmakeArgs.push("-GNinja")
  cmakeArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninjaPath}`)

  // iOS toolchain
  const toolchainFile = path.join(
    executorchRoot,
    "third-party/ios-cmake/ios.toolchain.cmake",
  )
  cmakeArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchainFile}`)
  cmakeArgs.push(`-DPLATFORM=${iosPlatform}`)
  cmakeArgs.push("-DDEPLOYMENT_TARGET=13.0")

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // ExecuTorch build flags
  cmakeArgs.push("-DEXECUTORCH_BUILD_XNNPACK=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXECUTOR_RUNNER=OFF")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_DATA_LOADER=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_FLAT_TENSOR=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_PORTABLE_OPS=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_KERNELS_OPTIMIZED=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_KERNELS_QUANTIZED=ON")

  // Verbose
  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=1")
  }

  // Display build configuration
  console.log("")
  console.log("=== iOS Build Configuration ===")
  console.log(`Target triple:      ${targetTriple}`)
  console.log(`iOS Platform:       ${iosPlatform}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Python:             ${pythonPath}`)
  console.log(`Build directory:    ${buildRoot}`)
  console.log(`Install directory:  ${installPrefix}`)
  console.log("====================================")
  console.log("")

  // Set environment variables
  Deno.env.set("CMAKE_MAKE_PROGRAM", ninjaPath)

  // Run CMake configuration
  console.log("Running CMake configuration")
  await builder.exec(cmakePath, ["-B", buildRoot, ...cmakeArgs], {
    cwd: executorchRoot,
  })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    maxJobs = (await builder.output("sysctl", ["-n", "hw.ncpu"])).stdout.trim()
  }

  // Build and install
  console.log(`Building ExecuTorch (${maxJobs} parallel jobs)`)
  await builder.exec(
    cmakePath,
    ["--build", buildRoot, "--target", "install", "-j", maxJobs],
    { cwd: executorchRoot },
  )

  console.log("")
  console.log("iOS build completed successfully!")
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
