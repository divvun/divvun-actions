import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"
type AndroidABI = "arm64-v8a" | "armeabi-v7a" | "x86_64" | "x86"

interface BuildPytorchAndroidOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
  abi?: AndroidABI
  apiLevel?: string
  vulkan?: boolean
  vulkanFp16?: boolean
  stlShared?: boolean
  lite?: boolean
}

export async function buildPytorchAndroid(options: BuildPytorchAndroidOptions) {
  const {
    buildType = "Release",
    clean = true,
    verbose = false,
    abi = "arm64-v8a",
    apiLevel = "21",
    vulkan = false,
    vulkanFp16 = false,
    stlShared = false,
    lite = false,
  } = options

  console.log("Building PyTorch for Android")

  const repoRoot = Deno.cwd()
  const pytorchRoot = path.join(repoRoot, "pytorch")

  // Download protobuf dependencies from GitHub releases if not present
  const { target } = options
  const protobufVersion = "v33.0"
  const hostTarget = "x86_64-unknown-linux-gnu"

  // Download host protoc (needed to run protoc compiler during build)
  const hostProtobufArtifact =
    `protobuf_${protobufVersion}_${hostTarget}.tar.gz`
  const hostProtobufPath = path.join(repoRoot, `target/${hostTarget}/protobuf`)

  try {
    await Deno.stat(path.join(hostProtobufPath, "bin/protoc"))
    console.log(`Host protobuf already exists at ${hostProtobufPath}`)
  } catch {
    console.log(
      `Downloading host protobuf ${protobufVersion} for ${hostTarget}...`,
    )
    const hostDownloadUrl =
      `https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/${hostProtobufArtifact}`
    await builder.exec("curl", [
      "-sSfL",
      hostDownloadUrl,
      "-o",
      hostProtobufArtifact,
    ])

    console.log(`Extracting ${hostProtobufArtifact}...`)
    await Deno.mkdir(path.join(repoRoot, `target/${hostTarget}`), {
      recursive: true,
    })
    await builder.exec("tar", [
      "-xzf",
      hostProtobufArtifact,
      "-C",
      path.join(repoRoot, `target/${hostTarget}`),
    ])
    await Deno.remove(hostProtobufArtifact)
    console.log(`Host protobuf extracted to ${hostProtobufPath}`)
  }

  // Download target protobuf (Android library to link against)
  const targetProtobufArtifact = `protobuf_${protobufVersion}_${target}.tar.gz`
  const targetProtobufPath = path.join(repoRoot, `target/${target}/protobuf`)

  try {
    await Deno.stat(path.join(targetProtobufPath, "lib/libprotobuf.a"))
    console.log(`Target protobuf already exists at ${targetProtobufPath}`)
  } catch {
    console.log(
      `Downloading target protobuf ${protobufVersion} for ${target}...`,
    )
    const targetDownloadUrl =
      `https://github.com/divvun/static-lib-build/releases/download/protobuf%2F${protobufVersion}/${targetProtobufArtifact}`
    await builder.exec("curl", [
      "-sSfL",
      targetDownloadUrl,
      "-o",
      targetProtobufArtifact,
    ])

    console.log(`Extracting ${targetProtobufArtifact}...`)
    await Deno.mkdir(path.join(repoRoot, `target/${target}`), {
      recursive: true,
    })
    await builder.exec("tar", [
      "-xzf",
      targetProtobufArtifact,
      "-C",
      path.join(repoRoot, `target/${target}`),
    ])
    await Deno.remove(targetProtobufArtifact)
    console.log(`Target protobuf extracted to ${targetProtobufPath}`)
  }

  // Check for ANDROID_NDK
  let androidNdk = Deno.env.get("ANDROID_NDK")
  if (!androidNdk) {
    androidNdk = Deno.env.get("ANDROID_NDK_HOME")
    if (androidNdk) {
      console.log(`Using ANDROID_NDK_HOME as ANDROID_NDK: ${androidNdk}`)
    } else {
      throw new Error(
        "ANDROID_NDK environment variable not set. Set ANDROID_NDK or ANDROID_NDK_HOME to your Android NDK directory.",
      )
    }
  }

  // Verify NDK directory exists
  try {
    await Deno.stat(androidNdk)
  } catch {
    throw new Error(`ANDROID_NDK directory does not exist: ${androidNdk}`)
  }

  // Get NDK version
  let androidNdkVersion = "unknown"
  try {
    const ndkPropsPath = path.join(androidNdk, "source.properties")
    const ndkProps = await Deno.readTextFile(ndkPropsPath)
    const match = ndkProps.match(/^Pkg\.Revision[^=]*= *([0-9]+)\..*$/m)
    if (match) {
      androidNdkVersion = match[1]
    }
  } catch {
    // Ignore if can't read version
  }

  // Detect host architecture and platform
  const hostArch = Deno.build.arch === "aarch64" ? "arm64" : "x86_64"
  const isLinux = Deno.build.os === "linux"

  // Get tool paths
  let ninjaPath: string
  let cmakePath: string

  if (!isLinux) {
    // macOS
    const brewPrefix = hostArch === "arm64" ? "/opt/homebrew" : "/usr/local"
    ninjaPath = `${brewPrefix}/bin/ninja`
    cmakePath = `${brewPrefix}/bin/cmake`

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
  } else {
    // Linux
    ninjaPath = (await builder.output("which", ["ninja"])).stdout.trim()
    cmakePath = (await builder.output("which", ["cmake"])).stdout.trim()
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

  // Determine target triple from ABI
  let targetTriple: string
  switch (abi) {
    case "arm64-v8a":
      targetTriple = "aarch64-linux-android"
      break
    case "armeabi-v7a":
      targetTriple = "armv7-linux-androideabi"
      break
    case "x86":
      targetTriple = "i686-linux-android"
      break
    case "x86_64":
      targetTriple = "x86_64-linux-android"
      break
  }

  // Set up directories
  const installPrefix = path.join(repoRoot, `target/${targetTriple}/pytorch`)
  const buildRoot = path.join(
    repoRoot,
    `build/${targetTriple}/pytorch`,
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

  // Patch pocketfft for Android (no aligned_alloc)
  const pocketfftPath = path.join(
    pytorchRoot,
    "third_party/pocketfft/pocketfft_hdronly.h",
  )
  try {
    let content = await Deno.readTextFile(pocketfftPath)
    content = content.replace(/__cplusplus >= 201703L/g, "0")
    await Deno.writeTextFile(pocketfftPath, content)
  } catch {
    // Ignore if patch fails
  }

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
    `-DCMAKE_PREFIX_PATH=${installPrefix};${protobufPrefix};${pythonPrefixPath}`,
  )
  cmakeArgs.push(`-DPython_EXECUTABLE=${pythonExecutable}`)

  // Use Ninja
  cmakeArgs.push("-GNinja")
  cmakeArgs.push(`-DCMAKE_MAKE_PROGRAM=${ninjaPath}`)

  // Suppress CMake deprecation warnings
  cmakeArgs.push("-DCMAKE_WARN_DEPRECATED=OFF")

  // Android toolchain
  cmakeArgs.push(
    `-DCMAKE_TOOLCHAIN_FILE=${androidNdk}/build/cmake/android.toolchain.cmake`,
  )
  cmakeArgs.push(`-DANDROID_NDK=${androidNdk}`)
  cmakeArgs.push(`-DANDROID_ABI=${abi}`)
  cmakeArgs.push(`-DANDROID_NATIVE_API_LEVEL=${apiLevel}`)
  cmakeArgs.push("-DANDROID_CPP_FEATURES=rtti exceptions")

  // Toolchain selection based on NDK version
  if (parseInt(androidNdkVersion) < 18) {
    cmakeArgs.push("-DANDROID_TOOLCHAIN=gcc")
  } else {
    cmakeArgs.push("-DANDROID_TOOLCHAIN=clang")
  }

  // STL configuration
  if (stlShared) {
    cmakeArgs.push("-DANDROID_STL=c++_shared")
  } else {
    cmakeArgs.push("-DANDROID_STL=c++_static")
  }

  // Build configuration
  cmakeArgs.push(`-DCMAKE_INSTALL_PREFIX=${installPrefix}`)
  cmakeArgs.push(`-DCMAKE_BUILD_TYPE=${buildType}`)

  // Set C++17 standard explicitly
  cmakeArgs.push("-DCMAKE_CXX_STANDARD=17")

  // Enable position independent code for static libraries
  cmakeArgs.push("-DCMAKE_POSITION_INDEPENDENT_CODE=ON")

  // Android always uses static libraries
  cmakeArgs.push("-DBUILD_SHARED_LIBS=OFF")

  // Lite interpreter
  if (lite) {
    cmakeArgs.push("-DBUILD_LITE_INTERPRETER=ON")
    cmakeArgs.push("-DUSE_LITE_INTERPRETER_PROFILER=OFF")
  } else {
    cmakeArgs.push("-DBUILD_LITE_INTERPRETER=OFF")
  }

  // Vulkan support
  if (vulkan || vulkanFp16) {
    cmakeArgs.push("-DUSE_VULKAN=ON")
    if (vulkanFp16) {
      cmakeArgs.push("-DUSE_VULKAN_FP16_INFERENCE=ON")
    }
  } else {
    cmakeArgs.push("-DUSE_VULKAN=OFF")
  }

  // Disable Python and tests
  cmakeArgs.push("-DBUILD_PYTHON=OFF")
  cmakeArgs.push("-DBUILD_TEST=OFF")
  cmakeArgs.push("-DBUILD_BINARY=OFF")
  cmakeArgs.push("-DBUILD_MOBILE_BENCHMARK=OFF")
  cmakeArgs.push("-DBUILD_MOBILE_TEST=OFF")

  // Disable unused dependencies
  cmakeArgs.push("-DUSE_CUDA=OFF")
  cmakeArgs.push("-DUSE_ITT=OFF")
  cmakeArgs.push("-DUSE_GFLAGS=OFF")
  cmakeArgs.push("-DUSE_OPENCV=OFF")
  cmakeArgs.push("-DUSE_MPI=OFF")
  cmakeArgs.push("-DUSE_OPENMP=OFF")
  cmakeArgs.push("-DUSE_KINETO=OFF")
  cmakeArgs.push("-DUSE_MKLDNN=OFF")
  cmakeArgs.push("-DUSE_FBGEMM=OFF")
  cmakeArgs.push("-DUSE_PROF=OFF")

  // Protobuf - Android needs host protoc for cross-compilation
  let hostProtoc = path.join(
    repoRoot,
    "target/x86_64-unknown-linux-gnu/protobuf/bin/protoc",
  )
  try {
    await Deno.stat(hostProtoc)
  } catch {
    hostProtoc = path.join(
      repoRoot,
      "target/aarch64-unknown-linux-gnu/protobuf/bin/protoc",
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
      `Custom protoc not found! Build host protoc first: divvun-actions run protobuf-build x86_64-unknown-linux-gnu\nThen build Android protobuf: divvun-actions run protobuf-build ${targetTriple}`,
    )
  }

  // Verify protobuf library exists
  try {
    await Deno.stat(customProtobufLib)
  } catch {
    throw new Error(
      `Custom protobuf library not found at ${customProtobufLib}! Build Android protobuf first: divvun-actions run protobuf-build ${targetTriple}`,
    )
  }

  console.log(`Using custom-built protoc from ${hostProtoc}`)
  console.log(`Using custom-built static Protobuf from ${customProtobufLib}`)
  cmakeArgs.push("-DBUILD_CUSTOM_PROTOBUF=OFF")
  cmakeArgs.push(`-DCAFFE2_CUSTOM_PROTOC_EXECUTABLE=${hostProtoc}`)
  cmakeArgs.push(`-DProtobuf_PROTOC_EXECUTABLE=${hostProtoc}`)
  cmakeArgs.push(`-DProtobuf_DIR=${customProtobufCmakeDir}`)

  // Performance: use mimalloc allocator
  cmakeArgs.push("-DUSE_MIMALLOC=ON")

  // Verbose
  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=1")
  }

  // Display build configuration
  console.log("")
  console.log("=== Android Build Configuration ===")
  console.log(`Target triple:      ${targetTriple}`)
  console.log(`Android NDK:        ${androidNdk}`)
  console.log(`NDK version:        ${androidNdkVersion}`)
  console.log(`ABI:                ${abi}`)
  console.log(`API level:          ${apiLevel}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Python:             ${pythonPath}`)
  console.log(`Output directory:   ${buildRoot}`)
  console.log(`BUILD_LITE:         ${lite}`)
  console.log(`USE_VULKAN:         ${vulkan || vulkanFp16}`)
  console.log(`STL:                ${stlShared ? "shared" : "static"}`)
  console.log("====================================")
  console.log("")

  // Set environment variables
  Deno.env.set("CMAKE_MAKE_PROGRAM", ninjaPath)

  // Run CMake configuration
  console.log("Running CMake configuration")
  await builder.exec(cmakePath, [pytorchRoot, ...cmakeArgs], { cwd: buildRoot })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    if (isLinux) {
      maxJobs = (await builder.output("nproc", [])).stdout.trim()
    } else {
      maxJobs = (await builder.output("sysctl", ["-n", "hw.ncpu"])).stdout
        .trim()
    }
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

  console.log("")
  console.log("Android build completed successfully!")
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
