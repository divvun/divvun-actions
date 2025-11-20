import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

interface BuildPytorchLinuxOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
  shared?: boolean
  distributed?: boolean
  lite?: boolean
}

export async function buildPytorchLinux(options: BuildPytorchLinuxOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
    shared = false,
    distributed = true, // Enabled by default on Linux
    lite = false,
  } = options

  console.log("Building PyTorch C++ libraries for Linux")

  const repoRoot = Deno.cwd()
  const pytorchRoot = path.join(repoRoot, "pytorch")

  // Download protobuf dependency from GitHub releases if not present
  const protobufVersion = "v33.0"
  const protobufArtifact = `protobuf_${protobufVersion}_${target}.tar.gz`
  const protobufPath = path.join(repoRoot, `target/${target}/protobuf`)

  try {
    await Deno.stat(path.join(protobufPath, "bin/protoc"))
    console.log(`Protobuf already exists at ${protobufPath}`)
  } catch {
    console.log(`Downloading protobuf ${protobufVersion} for ${target}...`)
    const downloadUrl =
      `https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/${protobufArtifact}`
    await builder.exec("curl", ["-sSfL", downloadUrl, "-o", protobufArtifact])

    // Extract protobuf artifact
    console.log(`Extracting ${protobufArtifact}...`)
    await Deno.mkdir(path.join(repoRoot, `target/${target}`), {
      recursive: true,
    })
    await builder.exec("tar", [
      "-xzf",
      protobufArtifact,
      "-C",
      path.join(repoRoot, `target/${target}`),
    ])
    await Deno.remove(protobufArtifact)
    console.log(`Protobuf extracted to ${protobufPath}`)
  }

  // Detect host architecture
  const hostArch = Deno.build.arch === "aarch64" ? "aarch64" : "x86_64"
  console.log(`Detected host architecture: ${hostArch}`)

  // Get tool paths
  const ninjaPath = (await builder.output("which", ["ninja"])).stdout.trim()
  const cmakePath = (await builder.output("which", ["cmake"])).stdout.trim()

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

  // Apply SLEEF patch
  console.log("Applying SLEEF patch")
  const sleefPatchPath = path.join(
    import.meta.dirname!,
    "patches/pytorch/aten-sleef.patch",
  )
  await builder.exec("patch", ["-p1", "-i", sleefPatchPath], {
    cwd: pytorchRoot,
  })

  // Determine target triple
  const targetTriple = target
  const hostTriple = hostArch === "aarch64"
    ? "aarch64-unknown-linux-gnu"
    : "x86_64-unknown-linux-gnu"

  const isCrossCompile = targetTriple !== hostTriple
  if (isCrossCompile) {
    console.log(`Cross-compiling: ${hostTriple} -> ${targetTriple}`)
  }

  // Parse target architecture from triple
  const targetArch = targetTriple.split("-")[0]

  // Set up directories
  const installPrefix = path.join(repoRoot, `target/${targetTriple}/pytorch`)
  const buildRoot = path.join(
    repoRoot,
    `target/${targetTriple}/build/pytorch`,
  )

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
  const sleefPrefix = path.join(repoRoot, `target/${targetTriple}/sleef`)

  // Prepare CMake arguments
  const cmakeArgs: string[] = []

  // Add all dependency prefixes to CMAKE_PREFIX_PATH
  cmakeArgs.push(
    `-DCMAKE_PREFIX_PATH=${installPrefix};${libompPrefix};${protobufPrefix};${sleefPrefix};${pythonPrefixPath}`,
  )
  cmakeArgs.push(`-DPython_EXECUTABLE=${pythonExecutable}`)

  // Use Ninja
  cmakeArgs.push("-GNinja")
  cmakeArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninjaPath}`)

  // Suppress CMake deprecation warnings
  cmakeArgs.push("-DCMAKE_WARN_DEPRECATED=OFF")

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // Cross-compilation configuration
  if (isCrossCompile) {
    cmakeArgs.push("-DCMAKE_SYSTEM_NAME=Linux")
    cmakeArgs.push(`-DCMAKE_SYSTEM_PROCESSOR=${targetArch}`)

    // Use cross-compiler for aarch64
    if (targetArch === "aarch64") {
      cmakeArgs.push("-DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc")
      cmakeArgs.push("-DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++")
      cmakeArgs.push("-DCMAKE_ASM_COMPILER=aarch64-linux-gnu-gcc")
      cmakeArgs.push("-DCMAKE_C_FLAGS=-march=armv8-a+sve")
      cmakeArgs.push("-DCMAKE_CXX_FLAGS=-march=armv8-a+sve")
    }
  }

  // Set C++17 standard explicitly
  cmakeArgs.push("-DCMAKE_CXX_STANDARD=17")

  // Enable position independent code for static libraries
  cmakeArgs.push("-DCMAKE_POSITION_INDEPENDENT_CODE=ON")

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

  // Check for custom-built OpenMP
  const customOpenmpLib = path.join(libompPrefix, "lib/libomp.a")
  const customOpenmpInclude = path.join(libompPrefix, "include")
  try {
    await Deno.stat(customOpenmpLib)
    console.log(`Using custom-built static OpenMP from ${customOpenmpLib}`)
    cmakeArgs.push("-DUSE_OPENMP=ON")
    cmakeArgs.push(
      `-DOpenMP_C_FLAGS=-fopenmp -I${customOpenmpInclude}`,
    )
    cmakeArgs.push(
      `-DOpenMP_CXX_FLAGS=-fopenmp -I${customOpenmpInclude}`,
    )
    cmakeArgs.push("-DOpenMP_C_LIB_NAMES=omp")
    cmakeArgs.push("-DOpenMP_CXX_LIB_NAMES=omp")
    cmakeArgs.push(`-DOpenMP_omp_LIBRARY=${customOpenmpLib}`)
  } catch {
    cmakeArgs.push("-DUSE_OPENMP=ON")
  }

  // Use system SLEEF library
  cmakeArgs.push("-DUSE_SYSTEM_SLEEF=ON")
  cmakeArgs.push(`-DSleef_DIR=${sleefPrefix}/lib/cmake/sleef`)

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
  cmakeArgs.push("-DUSE_NUMA=OFF")

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
  console.log("=== Linux Build Configuration ===")
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
  Deno.env.set("CC", "gcc")
  Deno.env.set("CXX", "g++")
  Deno.env.set("CMAKE_MAKE_PROGRAM", ninjaPath)

  // Run CMake configuration
  console.log("Running CMake configuration")
  await builder.exec(cmakePath, [pytorchRoot, ...cmakeArgs], { cwd: buildRoot })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    maxJobs = (await builder.output("nproc", [])).stdout.trim()
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
      path.join(buildRoot, "lib") + "/.",
      path.join(installPrefix, "lib") + "/",
    ])
  } catch {
    // Ignore if copy fails
  }
  try {
    await builder.exec("cp", [
      "-rf",
      path.join(buildRoot, "include") + "/.",
      path.join(installPrefix, "include") + "/",
    ])
  } catch {
    // Ignore if copy fails
  }

  // Copy SLEEF libraries into PyTorch bundle
  console.log("Copying SLEEF libraries")
  try {
    await builder.exec("cp", [
      "-rf",
      path.join(sleefPrefix, "lib") + "/.",
      path.join(installPrefix, "lib") + "/",
    ])
  } catch {
    // Ignore if copy fails
  }
  try {
    await builder.exec("cp", [
      "-rf",
      path.join(sleefPrefix, "include") + "/.",
      path.join(installPrefix, "include") + "/",
    ])
  } catch {
    // Ignore if copy fails
  }

  console.log("")
  console.log("Linux build completed successfully!")
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
