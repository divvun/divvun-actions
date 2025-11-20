import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

type Platform = "darwin" | "linux" | "windows"

export interface BuildSleefOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

function detectPlatform(target: string): Platform {
  if (target.includes("-apple-darwin") || target.includes("-apple-ios")) {
    return "darwin"
  } else if (target.includes("-linux-")) {
    return "linux"
  } else if (target.includes("-windows-")) {
    return "windows"
  }
  throw new Error(`Unsupported target triple: ${target}`)
}

export async function buildSleef(options: BuildSleefOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
    version = "3.6",
  } = options

  console.log(
    "Building SLEEF (SIMD Library for Evaluating Elementary Functions)",
  )

  const platform = detectPlatform(target)
  const repoRoot = Deno.cwd()
  const sleefDir = path.join(repoRoot, "sleef")
  const buildRoot = path.join(repoRoot, `target/${target}/build/sleef`)
  const installPrefix = path.join(repoRoot, `target/${target}/sleef`)

  // Detect cross-compilation
  const targetTriple = target
  const hostArch = Deno.build.arch
  const hostTriple = hostArch === "aarch64"
    ? "aarch64-unknown-linux-gnu"
    : "x86_64-unknown-linux-gnu"
  const isCrossCompile = platform === "linux" && targetTriple !== hostTriple
  const targetArch = targetTriple.split("-")[0]

  if (isCrossCompile) {
    console.log(`Cross-compiling: ${hostTriple} -> ${targetTriple}`)
  }

  // Set up compilers
  let cc: string
  let cxx: string
  let cmakePath: string
  let ninjaPath: string

  if (platform === "darwin") {
    cc = (await builder.output("xcrun", ["-f", "clang"])).stdout.trim()
    cxx = (await builder.output("xcrun", ["-f", "clang++"])).stdout.trim()

    const arch = Deno.build.arch
    const brewPrefix = arch === "aarch64" ? "/opt/homebrew" : "/usr/local"
    cmakePath = `${brewPrefix}/bin/cmake`
    ninjaPath = `${brewPrefix}/bin/ninja`
  } else if (platform === "linux") {
    try {
      await builder.exec("which", ["clang"])
      cc = "clang"
      cxx = "clang++"
    } catch {
      cc = "gcc"
      cxx = "g++"
    }
    cmakePath = (await builder.output("which", ["cmake"])).stdout.trim()
    ninjaPath = (await builder.output("which", ["ninja"])).stdout.trim()
  } else {
    // Windows
    cmakePath = (await builder.output("which", ["cmake"])).stdout.trim()
    ninjaPath = (await builder.output("which", ["ninja"])).stdout.trim()
    cc = "cl.exe"
    cxx = "cl.exe"
  }

  console.log("")
  console.log("=== SLEEF Build Configuration ===")
  console.log(`Target triple:      ${target}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Platform:           ${platform}`)
  console.log(`C compiler:         ${cc}`)
  console.log(`C++ compiler:       ${cxx}`)
  console.log(`SLEEF source:       ${sleefDir}`)
  console.log(`Build directory:    ${buildRoot}`)
  console.log(`Install prefix:     ${installPrefix}`)
  console.log("===================================")
  console.log("")

  // Clone SLEEF
  console.log("Removing existing SLEEF directory (if any)...")
  try {
    await Deno.remove(sleefDir, { recursive: true })
  } catch {
    // Ignore if doesn't exist
  }

  console.log(`Cloning SLEEF from GitHub (version ${version})...`)
  await builder.exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    version,
    "https://github.com/shibatch/sleef.git",
    sleefDir,
  ])

  // Clean build directory
  if (clean) {
    console.log("Cleaning build directory...")
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
  const cmakeArgs = [
    sleefDir,
    "-GNinja",
    `-DCMAKE_MAKE_PROGRAM=${ninjaPath}`,
    `-DCMAKE_BUILD_TYPE=${buildType}`,
    `-DCMAKE_INSTALL_PREFIX=${installPrefix}`,
    "-DCMAKE_CXX_STANDARD=17",
    `-DCMAKE_C_COMPILER=${cc}`,
    `-DCMAKE_CXX_COMPILER=${cxx}`,
    "-DBUILD_SHARED_LIBS=OFF",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    "-DBUILD_TESTS=OFF",
    "-DBUILD_DFT=OFF",
    "-DBUILD_GNUABI_LIBS=OFF",
    "-DBUILD_INLINE_HEADERS=OFF",
  ]

  // Enable ARM-specific SIMD features for aarch64
  if (targetArch === "aarch64") {
    cmakeArgs.push("-DSLEEF_ENABLE_SVE=ON")
    cmakeArgs.push("-DSLEEF_ENABLE_ADVSIMD=ON")
    cmakeArgs.push("-DCMAKE_C_FLAGS=-march=armv8-a+sve")
    cmakeArgs.push("-DCMAKE_CXX_FLAGS=-march=armv8-a+sve")
  }

  if (platform === "darwin") {
    cmakeArgs.push("-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0")
  } else if (platform === "windows") {
    cmakeArgs.push("-DCMAKE_C_COMPILER=cl.exe")
    cmakeArgs.push("-DCMAKE_CXX_COMPILER=cl.exe")
  } else if (isCrossCompile) {
    // Linux cross-compilation configuration
    cmakeArgs.push("-DCMAKE_SYSTEM_NAME=Linux")
    cmakeArgs.push(`-DCMAKE_SYSTEM_PROCESSOR=${targetArch}`)

    // Use cross-compiler for aarch64
    if (targetArch === "aarch64") {
      cmakeArgs.push("-DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc")
      cmakeArgs.push("-DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++")
    }

    // Point to native build directory for host tools
    const nativeBuildDir = path.join(
      repoRoot,
      `target/${hostTriple}/build/sleef`,
    )
    cmakeArgs.push(`-DNATIVE_BUILD_DIR=${nativeBuildDir}`)
  }

  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=ON")
  }

  // Run CMake configuration
  console.log("Running CMake configuration...")
  await builder.exec(cmakePath, cmakeArgs, { cwd: buildRoot })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    if (platform === "darwin") {
      maxJobs = (await builder.output("sysctl", ["-n", "hw.ncpu"])).stdout
        .trim()
    } else {
      try {
        maxJobs = (await builder.output("nproc", [])).stdout.trim()
      } catch {
        maxJobs = "4"
      }
    }
  }

  // Build
  console.log(`Building SLEEF (${maxJobs} parallel jobs)`)
  await builder.exec(
    cmakePath,
    ["--build", ".", "--target", "install", "--", `-j${maxJobs}`],
    { cwd: buildRoot },
  )

  console.log("")
  console.log("SLEEF build completed successfully!")
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
