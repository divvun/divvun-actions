import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

interface BuildPytorchMacosOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
  shared?: boolean
  distributed?: boolean
  lite?: boolean
}

export async function buildPytorchMacos(options: BuildPytorchMacosOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
    shared = false,
    distributed = false,
    lite = false,
  } = options

  console.log("Building PyTorch C++ libraries for macOS")

  const repoRoot = Deno.cwd()
  const pytorchRoot = path.join(repoRoot, "pytorch")

  // Detect host architecture
  const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64"
  console.log(`Detected host architecture: ${hostArch}`)

  // Determine brew prefix
  const brewPrefix = hostArch === "arm64" ? "/opt/homebrew" : "/usr/local"
  const ninjaPath = `${brewPrefix}/bin/ninja`
  const cmakePath = `${brewPrefix}/bin/cmake`

  // Check for Python venv
  const venvPath = path.join(pytorchRoot, ".venv")
  const pythonPath = path.join(venvPath, "bin/python")

  try {
    await Deno.stat(venvPath)
  } catch {
    console.log("No .venv found, creating one with uv...")
    await builder.exec("uv", ["venv"], { cwd: pytorchRoot })
  }

  console.log(`Using Python: ${pythonPath}`)

  // Install Python dependencies
  console.log("Installing Python dependencies")
  await builder.exec(
    "uv",
    ["pip", "install", "pyyaml", "setuptools", "typing-extensions"],
    { cwd: pytorchRoot },
  )

  // Fetch optional dependencies
  console.log("Fetching optional dependencies")
  const eigenCheck = path.join(pytorchRoot, "third_party/eigen/CMakeLists.txt")
  try {
    await Deno.stat(eigenCheck)
    console.log("Eigen already present")
  } catch {
    await builder.exec(
      pythonPath,
      ["tools/optional_submodules.py", "checkout_eigen"],
      { cwd: pytorchRoot },
    )
  }

  // Patch CMakeLists.txt
  const cmakeListsPath = path.join(pytorchRoot, "CMakeLists.txt")
  try {
    let content = await Deno.readTextFile(cmakeListsPath)
    content = content.replace(
      /(CMAKE_OSX_ARCHITECTURES MATCHES[^)]*x86_64[^)]*arm64[^)]*)\)/gm,
      "$1 AND NOT DEFINED CAFFE2_CUSTOM_PROTOC_EXECUTABLE)",
    )
    await Deno.writeTextFile(cmakeListsPath, content)
  } catch (error) {
    console.log(`Warning: Could not patch CMakeLists.txt: ${error}`)
  }

  // Determine target triple
  const targetTriple = target
  const hostTriple = hostArch === "arm64"
    ? "aarch64-apple-darwin"
    : "x86_64-apple-darwin"

  const isCrossCompile = targetTriple !== hostTriple
  if (isCrossCompile) {
    console.log(`Cross-compiling: ${hostTriple} -> ${targetTriple}`)
  }

  // Set up directories
  const installPrefix = path.join(repoRoot, `target/${targetTriple}/pytorch`)
  const buildRoot = path.join(
    repoRoot,
    `target/${targetTriple}/build/pytorch`,
  )

  if (clean) {
    console.log("Cleaning build directory...")
    try {
      await Deno.remove(buildRoot, { recursive: true })
    } catch {
      // Ignore if doesn't exist
    }
  }

  await Deno.mkdir(buildRoot, { recursive: true })

  // Get Python prefix path
  const pythonPrefixPath = (await builder.output(pythonPath, [
    "-c",
    "import sysconfig; print(sysconfig.get_path('purelib'))",
  ])).stdout.trim()

  const pythonExecutable = (await builder.output(pythonPath, [
    "-c",
    "import sys; print(sys.executable)",
  ])).stdout.trim()

  // Dependency prefixes
  const libompPrefix = path.join(repoRoot, `target/${targetTriple}/libomp`)
  const protobufPrefix = path.join(repoRoot, `target/${targetTriple}/protobuf`)
  const icu4cPrefix = path.join(repoRoot, `target/${targetTriple}/icu4c`)

  // Prepare CMake arguments
  const cmakeArgs: string[] = []

  // Add all dependency prefixes to CMAKE_PREFIX_PATH
  cmakeArgs.push(
    `-DCMAKE_PREFIX_PATH=${installPrefix};${libompPrefix};${protobufPrefix};${icu4cPrefix};${pythonPrefixPath}`,
  )
  cmakeArgs.push(`-DPython_EXECUTABLE=${pythonExecutable}`)

  // Ensure ONNX and other components use our custom Abseil
  cmakeArgs.push(`-Dabsl_DIR=${installPrefix}/lib/cmake/absl`)

  // Use Ninja
  cmakeArgs.push("-GNinja")
  cmakeArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninjaPath}`)

  // Suppress CMake deprecation warnings
  cmakeArgs.push("-DCMAKE_WARN_DEPRECATED=OFF")

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // Set C++17 standard explicitly
  cmakeArgs.push("-DCMAKE_CXX_STANDARD=17")

  // Cross-compilation: Set target architecture
  if (isCrossCompile) {
    if (targetTriple === "x86_64-apple-darwin") {
      cmakeArgs.push("-DCMAKE_OSX_ARCHITECTURES=x86_64")
      console.log("Setting CMAKE_OSX_ARCHITECTURES=x86_64 for cross-compilation")
    } else if (targetTriple === "aarch64-apple-darwin") {
      cmakeArgs.push("-DCMAKE_OSX_ARCHITECTURES=arm64")
      console.log("Setting CMAKE_OSX_ARCHITECTURES=arm64 for cross-compilation")
    }
  }

  // Static or shared libraries
  if (shared) {
    cmakeArgs.push("-DBUILD_SHARED_LIBS=ON")
  } else {
    cmakeArgs.push("-DBUILD_SHARED_LIBS=OFF")
  }

  // Lite interpreter
  if (lite) {
    cmakeArgs.push("-DBUILD_LITE_INTERPRETER=ON")
    cmakeArgs.push("-DUSE_LITE_INTERPRETER_PROFILER=OFF")
  } else {
    cmakeArgs.push("-DBUILD_LITE_INTERPRETER=OFF")
  }

  // Disable Python bindings and tests
  cmakeArgs.push("-DBUILD_PYTHON=OFF")
  cmakeArgs.push("-DBUILD_TEST=OFF")
  cmakeArgs.push("-DBUILD_BINARY=OFF")

  // macOS-specific features
  cmakeArgs.push("-DUSE_PYTORCH_METAL=OFF")

  // Check for custom-built OpenMP
  const customOpenmpLib = path.join(libompPrefix, "lib/libomp.a")
  const customOpenmpInclude = path.join(libompPrefix, "include")
  try {
    await Deno.stat(customOpenmpLib)
    console.log(`Using custom-built static OpenMP from ${customOpenmpLib}`)
    cmakeArgs.push("-DUSE_OPENMP=ON")
    cmakeArgs.push(
      `-DOpenMP_C_FLAGS=-Xpreprocessor -fopenmp -I${customOpenmpInclude}`,
    )
    cmakeArgs.push(
      `-DOpenMP_CXX_FLAGS=-Xpreprocessor -fopenmp -I${customOpenmpInclude}`,
    )
    cmakeArgs.push("-DOpenMP_C_LIB_NAMES=omp")
    cmakeArgs.push("-DOpenMP_CXX_LIB_NAMES=omp")
    cmakeArgs.push(`-DOpenMP_omp_LIBRARY=${customOpenmpLib}`)
  } catch {
    cmakeArgs.push("-DUSE_OPENMP=ON")
  }

  if (distributed) {
    cmakeArgs.push("-DUSE_DISTRIBUTED=ON")
  } else {
    cmakeArgs.push("-DUSE_DISTRIBUTED=OFF")
  }

  // Disable unused dependencies
  cmakeArgs.push("-DUSE_CUDA=OFF")
  cmakeArgs.push("-DUSE_ITT=OFF")
  cmakeArgs.push("-DUSE_GFLAGS=OFF")
  cmakeArgs.push("-DUSE_OPENCV=OFF")
  cmakeArgs.push("-DUSE_MPI=OFF")
  cmakeArgs.push("-DUSE_KINETO=OFF")
  cmakeArgs.push("-DUSE_MKLDNN=OFF")
  cmakeArgs.push("-DUSE_FBGEMM=OFF")
  cmakeArgs.push("-DUSE_PROF=OFF")
  cmakeArgs.push("-DUSE_MPS=OFF")

  // Check for custom-built Protobuf
  const hostProtobufPrefix = isCrossCompile
    ? path.join(repoRoot, `target/${hostTriple}/protobuf`)
    : protobufPrefix

  const customProtoc = path.join(hostProtobufPrefix, "bin/protoc")
  const customProtobufLib = path.join(protobufPrefix, "lib/libprotobuf.a")
  const customProtobufCmakeDir = path.join(
    protobufPrefix,
    "lib/cmake/protobuf",
  )

  // Verify protoc executable exists
  try {
    await Deno.stat(customProtoc)
  } catch {
    throw new Error(
      `Custom protoc not found at ${customProtoc}! Build protobuf first.`,
    )
  }

  // Verify protobuf library exists
  try {
    await Deno.stat(customProtobufLib)
  } catch {
    throw new Error(
      `Custom protobuf library not found at ${customProtobufLib}! Build protobuf first.`,
    )
  }

  console.log(`Using custom-built protoc from ${customProtoc}`)
  console.log(`Using custom-built static Protobuf from ${customProtobufLib}`)
  cmakeArgs.push("-DBUILD_CUSTOM_PROTOBUF=OFF")
  cmakeArgs.push(`-DCAFFE2_CUSTOM_PROTOC_EXECUTABLE=${customProtoc}`)
  cmakeArgs.push(`-DProtobuf_PROTOC_EXECUTABLE=${customProtoc}`)
  cmakeArgs.push(`-DProtobuf_DIR=${customProtobufCmakeDir}`)

  // Performance: use mimalloc allocator
  cmakeArgs.push("-DUSE_MIMALLOC=ON")

  // Verbose
  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=1")
  }

  // Display build configuration
  console.log("")
  console.log("=== macOS Build Configuration ===")
  console.log(`Target triple:      ${targetTriple}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Library type:       ${shared ? "shared" : "static"}`)
  console.log(`Python:             ${pythonPath}`)
  console.log(`Output directory:   ${buildRoot}`)
  console.log(`USE_DISTRIBUTED:    ${distributed}`)
  console.log(`BUILD_LITE:         ${lite}`)
  console.log("====================================")
  console.log("")

  // Set environment variables
  Deno.env.set("CC", "clang")
  Deno.env.set("CXX", "clang++")
  Deno.env.set("MACOSX_DEPLOYMENT_TARGET", "11.0")
  Deno.env.set("CMAKE_MAKE_PROGRAM", ninjaPath)

  // Run CMake configuration
  console.log("Running CMake configuration")
  await builder.exec(cmakePath, [pytorchRoot, ...cmakeArgs], { cwd: buildRoot })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    maxJobs = (await builder.output("sysctl", ["-n", "hw.ncpu"])).stdout.trim()
  }

  // Build
  console.log(`Building PyTorch (${maxJobs} parallel jobs)`)
  await builder.exec(
    cmakePath,
    ["--build", ".", "--target", "install", "--", `-j${maxJobs}`],
    { cwd: buildRoot },
  )

  // Install libraries and headers
  console.log("Installing libraries and headers")
  try {
    await builder.exec("cp", [
      "-rf",
      path.join(buildRoot, "lib/"),
      path.join(installPrefix, "lib/"),
    ])
  } catch {
    // Ignore if copy fails
  }
  try {
    await builder.exec("cp", [
      "-rf",
      path.join(buildRoot, "include/"),
      path.join(installPrefix, "include/"),
    ])
  } catch {
    // Ignore if copy fails
  }

  console.log("")
  console.log("macOS build completed successfully!")
  console.log("")
  console.log(`Target: ${targetTriple}`)
  console.log("")
  console.log("Library files:")
  console.log(`  ${buildRoot}/lib/`)
  console.log("")
  console.log("Header files:")
  console.log(`  ${buildRoot}/include/`)
  console.log("")
}
