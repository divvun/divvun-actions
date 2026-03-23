import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

interface BuildExecutorchWindowsOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

export async function buildExecutorchWindows(
  options: BuildExecutorchWindowsOptions,
) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
  } = options

  logger.info(`Building ExecuTorch for Windows (${target})`)

  const repoRoot = Deno.cwd()
  const executorchRoot = path.join(repoRoot, "executorch")

  // Determine if this is ARM64 cross-compile
  const isArm64 = target === "aarch64-pc-windows-msvc"

  // Check for Python venv
  const venvPath = path.join(executorchRoot, ".venv")
  const pythonPath = path.join(venvPath, "Scripts/python.exe")

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

  // Apply Windows patch (Ninja ExternalProject fixes for flatc/flatcc)
  logger.info("Applying Windows patch")
  const windowsPatchPath = path.join(
    import.meta.dirname!,
    "patches/executorch/windows.patch",
  )
  const patchResult = await builder.output("C:\\msys2\\usr\\bin\\patch.exe", [
    "-p1",
    "-i",
    windowsPatchPath,
  ], {
    cwd: executorchRoot,
  })
  logger.info(patchResult.stdout)
  if (patchResult.stderr) {
    logger.info(patchResult.stderr)
  }

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

  // VS2022 LLVM tools path for clang-cl
  const llvmBinPath =
    "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Tools\\Llvm\\x64\\bin"

  // Use Ninja with clang-cl - use full paths since CMake doesn't search PATH properly
  cmakeArgs.push("-GNinja")
  cmakeArgs.push(`-DCMAKE_C_COMPILER=${llvmBinPath}\\clang-cl.exe`)
  cmakeArgs.push(`-DCMAKE_CXX_COMPILER=${llvmBinPath}\\clang-cl.exe`)
  cmakeArgs.push(`-DCMAKE_LINKER=${llvmBinPath}\\lld-link.exe`)

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)
  cmakeArgs.push("-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded")

  // ARM64 cross-compilation
  if (isArm64) {
    cmakeArgs.push("-DCMAKE_C_COMPILER_TARGET=aarch64-pc-windows-msvc")
    cmakeArgs.push("-DCMAKE_CXX_COMPILER_TARGET=aarch64-pc-windows-msvc")
  }

  // ExecuTorch build flags
  cmakeArgs.push("-DEXECUTORCH_BUILD_XNNPACK=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXECUTOR_RUNNER=OFF")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_NAMED_DATA_MAP=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_DATA_LOADER=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_FLAT_TENSOR=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_MODULE=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_EXTENSION_TENSOR=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_DEVTOOLS=ON")
  cmakeArgs.push("-DEXECUTORCH_ENABLE_EVENT_TRACER=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_PORTABLE_OPS=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_KERNELS_OPTIMIZED=ON")
  cmakeArgs.push("-DEXECUTORCH_BUILD_KERNELS_QUANTIZED=ON")

  // Verbose
  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=1")
  }

  // Display build configuration
  logger.info("")
  logger.info("=== Windows Build Configuration ===")
  logger.info(`Target triple:      ${target}`)
  logger.info(`ARM64 build:        ${isArm64}`)
  logger.info(`Build type:         ${buildType}`)
  logger.info(`Python:             ${pythonPath}`)
  logger.info(`Build directory:    ${buildRoot}`)
  logger.info(`Install directory:  ${installPrefix}`)
  logger.info("====================================")
  logger.info("")

  // Build environment with venv activated (matching Linux approach)
  // Also add LLVM tools to PATH for other build tools
  const venvBinPath = path.join(venvPath, "Scripts")
  const currentPath = Deno.env.get("PATH") || ""
  const buildEnv: Record<string, string> = {
    ...Object.fromEntries(Object.entries(Deno.env.toObject())),
    PATH: `${llvmBinPath};${venvBinPath};${currentPath}`,
    VIRTUAL_ENV: venvPath,
  }

  logger.info(`Using venv: ${venvPath}`)

  // Run CMake configuration
  logger.info("Running CMake configuration")
  await builder.exec("cmake", ["-B", buildRoot, ...cmakeArgs], {
    cwd: executorchRoot,
    env: buildEnv,
  })

  // Build and install
  logger.info("Building ExecuTorch")
  await builder.exec(
    "cmake",
    ["--build", buildRoot, "--config", buildType, "--target", "install"],
    { cwd: executorchRoot, env: buildEnv },
  )

  logger.info("")
  logger.info("Windows build completed successfully!")
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
