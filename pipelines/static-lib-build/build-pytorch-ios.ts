import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"
type IosPlatform = "OS" | "SIMULATOR" | "WATCHOS"

interface BuildPytorchIosOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
  simulator?: "arm64" | "x86_64"
  watchos?: boolean
  metal?: boolean
  coreml?: boolean
  bitcode?: boolean
  lite?: boolean
}

export async function buildPytorchIos(options: BuildPytorchIosOptions) {
  const {
    buildType = "MinSizeRel",
    clean = true,
    verbose = false,
    simulator,
    watchos = false,
    metal = false,
    coreml = false,
    bitcode = false,
    lite = true, // Lite interpreter is default for iOS
  } = options

  console.log("Building PyTorch for iOS")

  const repoRoot = Deno.cwd()
  const pytorchRoot = path.join(repoRoot, "pytorch")

  // Detect host architecture
  const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64"
  const brewPrefix = hostArch === "arm64" ? "/opt/homebrew" : "/usr/local"

  // Get tool paths
  const ninjaPath = `${brewPrefix}/bin/ninja`
  const cmakePath = `${brewPrefix}/bin/cmake`

  try {
    await Deno.stat(ninjaPath)
  } catch {
    throw new Error(
      `ninja not found at ${ninjaPath}. Install it with: brew install ninja`,
    )
  }

  try {
    await Deno.stat(cmakePath)
  } catch {
    throw new Error(
      `cmake not found at ${cmakePath}. Install it with: brew install cmake`,
    )
  }

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

  // Determine platform and architecture
  let iosPlatform: IosPlatform
  let iosArch: string
  let targetTriple: string

  if (watchos) {
    iosPlatform = "WATCHOS"
    iosArch = "arm64_32"
    targetTriple = "arm64_32-apple-watchos"
  } else if (simulator) {
    iosPlatform = "SIMULATOR"
    iosArch = simulator
    targetTriple = simulator === "arm64"
      ? "aarch64-apple-ios-sim"
      : "x86_64-apple-ios-sim"
  } else {
    iosPlatform = "OS"
    iosArch = "arm64"
    targetTriple = "aarch64-apple-ios"
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
  const protobufPrefix = path.join(repoRoot, `target/${targetTriple}/protobuf`)

  // Prepare CMake arguments
  const cmakeArgs: string[] = []

  // Add all dependency prefixes to CMAKE_PREFIX_PATH
  cmakeArgs.push(
    `-DCMAKE_PREFIX_PATH=${protobufPrefix};${pythonPrefixPath}`,
  )
  cmakeArgs.push(`-DPython_EXECUTABLE=${pythonExecutable}`)

  // Use Ninja
  cmakeArgs.push("-GNinja")
  cmakeArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninjaPath}`)

  // Suppress CMake deprecation warnings
  cmakeArgs.push("-DCMAKE_WARN_DEPRECATED=OFF")

  // Determine SDK for compiler detection
  let iosSdk: string
  if (iosPlatform === "OS") {
    iosSdk = "iphoneos"
  } else if (iosPlatform === "SIMULATOR") {
    iosSdk = "iphonesimulator"
  } else {
    iosSdk = "watchos"
  }

  // Set compilers (required for iOS cross-compilation with Objective-C)
  const clangC = (await builder.output("xcrun", [
    "--sdk",
    iosSdk,
    "--find",
    "clang",
  ])).stdout.trim()
  const clangCxx = (await builder.output("xcrun", [
    "--sdk",
    iosSdk,
    "--find",
    "clang++",
  ])).stdout.trim()

  cmakeArgs.push(`-DCMAKE_C_COMPILER=${clangC}`)
  cmakeArgs.push(`-DCMAKE_CXX_COMPILER=${clangCxx}`)
  cmakeArgs.push(`-DCMAKE_OBJC_COMPILER=${clangC}`)
  cmakeArgs.push(`-DCMAKE_OBJCXX_COMPILER=${clangCxx}`)

  // iOS toolchain
  cmakeArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${pytorchRoot}/cmake/iOS.cmake`)
  cmakeArgs.push(`-DIOS_PLATFORM=${iosPlatform}`)
  cmakeArgs.push(`-DIOS_ARCH=${iosArch}`)

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // Set C++17 standard explicitly
  cmakeArgs.push("-DCMAKE_CXX_STANDARD=17")

  // iOS always uses static libraries
  cmakeArgs.push("-DBUILD_SHARED_LIBS=OFF")

  // Bitcode and Objective-C ARC
  if (bitcode || watchos) {
    cmakeArgs.push("-DCMAKE_C_FLAGS=-fembed-bitcode")
    cmakeArgs.push("-DCMAKE_CXX_FLAGS=-fembed-bitcode -fobjc-arc")
  } else {
    cmakeArgs.push("-DCMAKE_CXX_FLAGS=-fobjc-arc")
  }

  // Lite interpreter
  if (lite) {
    cmakeArgs.push("-DBUILD_LITE_INTERPRETER=ON")
    cmakeArgs.push("-DUSE_LITE_INTERPRETER_PROFILER=OFF")
  } else {
    cmakeArgs.push("-DBUILD_LITE_INTERPRETER=OFF")
  }

  // Features
  if (metal) {
    cmakeArgs.push("-DUSE_PYTORCH_METAL=ON")
  }

  if (coreml) {
    cmakeArgs.push("-DUSE_COREML_DELEGATE=ON")
  }

  // Disable Python and tests
  cmakeArgs.push("-DBUILD_PYTHON=OFF")
  cmakeArgs.push("-DBUILD_TEST=OFF")
  cmakeArgs.push("-DBUILD_BINARY=OFF")

  // Disable unused dependencies
  cmakeArgs.push("-DUSE_CUDA=OFF")
  cmakeArgs.push("-DUSE_ITT=OFF")
  cmakeArgs.push("-DUSE_GFLAGS=OFF")
  cmakeArgs.push("-DUSE_OPENCV=OFF")
  cmakeArgs.push("-DUSE_MPI=OFF")
  cmakeArgs.push("-DUSE_NUMPY=OFF")
  cmakeArgs.push("-DUSE_MKLDNN=OFF")
  cmakeArgs.push("-DUSE_FBGEMM=OFF")
  cmakeArgs.push("-DUSE_KINETO=OFF")
  cmakeArgs.push("-DUSE_PROF=OFF")
  cmakeArgs.push("-DINTERN_BUILD_MOBILE=ON")
  cmakeArgs.push("-DUSE_INDUCTOR=OFF")
  cmakeArgs.push("-DC10_MOBILE=ON")
  cmakeArgs.push("-DUSE_LITE_AOTI=OFF")

  // Performance: use mimalloc allocator
  cmakeArgs.push("-DUSE_MIMALLOC=ON")

  // Disable NNPACK for all platforms, QNNPACK only for watchOS
  cmakeArgs.push("-DUSE_NNPACK=OFF")
  if (iosPlatform === "WATCHOS") {
    cmakeArgs.push("-DUSE_PYTORCH_QNNPACK=OFF")
  }

  // Threading
  cmakeArgs.push("-DCMAKE_THREAD_LIBS_INIT=-lpthread")
  cmakeArgs.push("-DCMAKE_HAVE_THREADS_LIBRARY=1")
  cmakeArgs.push("-DCMAKE_USE_PTHREADS_INIT=1")

  // Protobuf - iOS needs host protoc for cross-compilation
  let hostProtoc = path.join(
    repoRoot,
    "target/aarch64-apple-darwin/protobuf/bin/protoc",
  )
  try {
    await Deno.stat(hostProtoc)
  } catch {
    hostProtoc = path.join(
      repoRoot,
      "target/x86_64-apple-darwin/protobuf/bin/protoc",
    )
  }

  const customProtobufLib = path.join(protobufPrefix, "lib/libprotobuf.a")
  const customProtobufCmakeDir = path.join(
    protobufPrefix,
    "lib/cmake/protobuf",
  )

  // Verify protoc executable exists
  try {
    await Deno.stat(hostProtoc)
  } catch {
    throw new Error(
      `Custom protoc not found! Build host protoc first: divvun-actions run protobuf-build aarch64-apple-darwin\nThen build iOS protobuf: divvun-actions run protobuf-build ${targetTriple}`,
    )
  }

  // Verify protobuf library exists
  try {
    await Deno.stat(customProtobufLib)
  } catch {
    throw new Error(
      `Custom protobuf library not found at ${customProtobufLib}! Build iOS protobuf first: divvun-actions run protobuf-build ${targetTriple}`,
    )
  }

  console.log(`Using custom-built protoc from ${hostProtoc}`)
  console.log(`Using custom-built static Protobuf from ${customProtobufLib}`)
  cmakeArgs.push("-DBUILD_CUSTOM_PROTOBUF=OFF")
  cmakeArgs.push(`-DCAFFE2_CUSTOM_PROTOC_EXECUTABLE=${hostProtoc}`)
  cmakeArgs.push(`-DProtobuf_PROTOC_EXECUTABLE=${hostProtoc}`)
  cmakeArgs.push(`-DProtobuf_DIR=${customProtobufCmakeDir}`)

  // Verbose
  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=1")
  }

  // Display build configuration
  console.log("")
  console.log("=== iOS Build Configuration ===")
  console.log(`Target triple:      ${targetTriple}`)
  console.log(`Platform:           ${iosPlatform}`)
  console.log(`Architecture:       ${iosArch}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Python:             ${pythonPath}`)
  console.log(`Output directory:   ${buildRoot}`)
  console.log(`USE_PYTORCH_METAL:  ${metal}`)
  console.log(`USE_COREML:         ${coreml}`)
  console.log(`BUILD_LITE:         ${lite}`)
  console.log(`ENABLE_BITCODE:     ${bitcode || watchos}`)
  console.log("===================================")
  console.log("")

  // Set environment variables
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

  console.log("")
  console.log("iOS build completed successfully!")
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
