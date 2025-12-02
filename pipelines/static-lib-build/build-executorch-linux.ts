import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

interface BuildExecutorchLinuxOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

export async function buildExecutorchLinux(options: BuildExecutorchLinuxOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
  } = options

  console.log(`Building ExecuTorch for Linux (${target})`)

  const repoRoot = Deno.cwd()
  const executorchRoot = path.join(repoRoot, "executorch")

  // Detect host architecture
  const hostArch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64"
  console.log(`Detected host architecture: ${hostArch}`)

  // Determine target architecture and libc
  const targetArch = target.startsWith("aarch64") ? "aarch64" : "x86_64"
  const isMusl = target.includes("-musl")
  const hostTriple = isMusl
    ? `${hostArch}-unknown-linux-musl`
    : `${hostArch}-unknown-linux-gnu`
  const isCrossCompile = target !== hostTriple

  if (isCrossCompile) {
    console.log(`Cross-compiling: ${hostTriple} -> ${target}`)
  }

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

  // Set up directories
  const installPrefix = path.join(repoRoot, `target/${target}/executorch`)
  const buildRoot = path.join(repoRoot, `build/${target}/executorch`)

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

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // Cross-compilation setup
  if (isCrossCompile && targetArch === "aarch64") {
    cmakeArgs.push("-DCMAKE_SYSTEM_NAME=Linux")
    cmakeArgs.push("-DCMAKE_SYSTEM_PROCESSOR=aarch64")

    if (isMusl) {
      // musl cross-compiler
      cmakeArgs.push("-DCMAKE_C_COMPILER=aarch64-linux-musl-gcc")
      cmakeArgs.push("-DCMAKE_CXX_COMPILER=aarch64-linux-musl-g++")
      cmakeArgs.push(
        "-DCMAKE_SYSROOT=/opt/aarch64-linux-musl-cross/aarch64-linux-musl",
      )
      cmakeArgs.push(
        "-DCMAKE_FIND_ROOT_PATH=/opt/aarch64-linux-musl-cross/aarch64-linux-musl",
      )
    } else {
      // glibc cross-compiler
      cmakeArgs.push("-DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc")
      cmakeArgs.push("-DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++")
    }
  } else if (isMusl && targetArch === "x86_64") {
    // x86_64 musl native build
    cmakeArgs.push("-DCMAKE_C_COMPILER=x86_64-linux-musl-gcc")
    cmakeArgs.push("-DCMAKE_CXX_COMPILER=x86_64-linux-musl-g++")
    cmakeArgs.push(
      "-DCMAKE_SYSROOT=/opt/x86_64-linux-musl-cross/x86_64-linux-musl",
    )
    cmakeArgs.push(
      "-DCMAKE_FIND_ROOT_PATH=/opt/x86_64-linux-musl-cross/x86_64-linux-musl",
    )
  }

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
  console.log("=== Linux Build Configuration ===")
  console.log(`Target triple:      ${target}`)
  console.log(`Host triple:        ${hostTriple}`)
  console.log(`Cross-compile:      ${isCrossCompile}`)
  console.log(`Using musl:         ${isMusl}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Python:             ${pythonPath}`)
  console.log(`Build directory:    ${buildRoot}`)
  console.log(`Install directory:  ${installPrefix}`)
  console.log("====================================")
  console.log("")

  // Run CMake configuration
  console.log("Running CMake configuration")
  await builder.exec("cmake", ["-B", buildRoot, ...cmakeArgs], {
    cwd: executorchRoot,
  })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    maxJobs = (await builder.output("nproc", [])).stdout.trim()
  }

  // Build and install
  console.log(`Building ExecuTorch (${maxJobs} parallel jobs)`)
  await builder.exec(
    "cmake",
    ["--build", buildRoot, "--target", "install", "-j", maxJobs],
    { cwd: executorchRoot },
  )

  console.log("")
  console.log("Linux build completed successfully!")
  console.log("")
  console.log(`Target: ${target}`)
  console.log("")
  console.log("Library files:")
  console.log(`  ${installPrefix}/lib/`)
  console.log("")
  console.log("Header files:")
  console.log(`  ${installPrefix}/include/`)
  console.log("")
}
