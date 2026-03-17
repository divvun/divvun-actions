import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

interface BuildExecutorchLinuxOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

export async function buildExecutorchLinux(
  options: BuildExecutorchLinuxOptions,
) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
  } = options

  logger.info(`Building ExecuTorch for Linux (${target})`)

  const repoRoot = Deno.cwd()
  const executorchRoot = path.join(repoRoot, "executorch")

  // Detect host architecture
  const hostArch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64"
  logger.info(`Detected host architecture: ${hostArch}`)

  // Determine target architecture and libc
  const targetArch = target.startsWith("aarch64") ? "aarch64" : "x86_64"
  const isMusl = target.includes("-musl")
  const hostTriple = isMusl
    ? `${hostArch}-unknown-linux-musl`
    : `${hostArch}-unknown-linux-gnu`
  const isCrossCompile = target !== hostTriple

  if (isCrossCompile) {
    logger.info(`Cross-compiling: ${hostTriple} -> ${target}`)
  }

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

  // Set up directories
  const installPrefix = path.join(repoRoot, `target/${target}/executorch`)
  const buildRoot = path.join(repoRoot, `build/${target}/executorch`)

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

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // Cross-compilation setup
  if (isCrossCompile && targetArch === "aarch64") {
    cmakeArgs.push("-DCMAKE_SYSTEM_NAME=Linux")
    cmakeArgs.push("-DCMAKE_SYSTEM_PROCESSOR=aarch64")

    if (isMusl) {
      // Use musl-clang wrapper scripts for cross-compilation
      const scriptsDir = path.join(import.meta.dirname!, "../../scripts")
      cmakeArgs.push(
        `-DCMAKE_C_COMPILER=${scriptsDir}/aarch64-linux-musl-clang`,
      )
      cmakeArgs.push(
        `-DCMAKE_CXX_COMPILER=${scriptsDir}/aarch64-linux-musl-clang++`,
      )
      cmakeArgs.push("-DCMAKE_C_FLAGS=-flto=thin -fPIC")
      cmakeArgs.push("-DCMAKE_CXX_FLAGS=-flto=thin -fPIC")
      cmakeArgs.push("-DCMAKE_EXE_LINKER_FLAGS=-flto=thin -fuse-ld=lld -static")
      cmakeArgs.push("-DCMAKE_AR=/usr/lib/llvm21/bin/llvm-ar")
      cmakeArgs.push("-DCMAKE_RANLIB=/usr/lib/llvm21/bin/llvm-ranlib")
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
    // Use musl-clang wrapper scripts
    const scriptsDir = path.join(import.meta.dirname!, "../../scripts")
    cmakeArgs.push(`-DCMAKE_C_COMPILER=${scriptsDir}/x86_64-linux-musl-clang`)
    cmakeArgs.push(
      `-DCMAKE_CXX_COMPILER=${scriptsDir}/x86_64-linux-musl-clang++`,
    )
    cmakeArgs.push("-DCMAKE_C_FLAGS=-flto=thin -fPIC")
    cmakeArgs.push("-DCMAKE_CXX_FLAGS=-flto=thin -fPIC")
    cmakeArgs.push("-DCMAKE_EXE_LINKER_FLAGS=-flto=thin -fuse-ld=lld -static")
    cmakeArgs.push("-DCMAKE_AR=/usr/lib/llvm21/bin/llvm-ar")
    cmakeArgs.push("-DCMAKE_RANLIB=/usr/lib/llvm21/bin/llvm-ranlib")
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
  logger.info("=== Linux Build Configuration ===")
  logger.info(`Target triple:      ${target}`)
  logger.info(`Host triple:        ${hostTriple}`)
  logger.info(`Cross-compile:      ${isCrossCompile}`)
  logger.info(`Using musl:         ${isMusl}`)
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
    maxJobs = (await builder.output("nproc", [])).stdout.trim()
  }

  // Build and install
  logger.info(`Building ExecuTorch (${maxJobs} parallel jobs)`)
  await builder.exec(
    "cmake",
    ["--build", buildRoot, "--target", "install", "-j", maxJobs],
    { cwd: executorchRoot, env: buildEnv },
  )

  logger.info("")
  logger.info("Linux build completed successfully!")
  logger.info("")
  logger.info(`Target: ${target}`)
  logger.info("")
  logger.info("Library files:")
  logger.info(`  ${installPrefix}/lib/`)
  logger.info("")
  logger.info("Header files:")
  logger.info(`  ${installPrefix}/include/`)
  logger.info("")
}
