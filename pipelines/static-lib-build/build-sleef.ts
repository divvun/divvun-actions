import * as path from "@std/path"
import { exec, output } from "~/util/process.ts"

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
    version = "3.9.0",
  } = options

  console.log(
    "Building SLEEF (SIMD Library for Evaluating Elementary Functions)",
  )

  const platform = detectPlatform(target)
  const repoRoot = Deno.cwd()
  const sleefDir = path.join(repoRoot, "sleef")
  const buildRoot = path.join(repoRoot, `build/${target}/sleef`)
  const installPrefix = path.join(repoRoot, `target/${target}/sleef`)

  // Detect if host is Alpine (musl) by checking for /etc/alpine-release
  const isAlpine = Deno.build.os === "linux" &&
    (await Deno.stat("/etc/alpine-release").catch(() => null)) !== null

  // Detect cross-compilation
  const targetTriple = target
  const hostArch = Deno.build.arch
  let hostTriple: string

  if (isAlpine) {
    switch (targetTriple) {
      case "x86_64-unknown-linux-musl":
      case "aarch64-unknown-linux-musl":
        hostTriple = "x86_64-unknown-linux-musl"
        break
      default:
        throw new Error(`Unsupported target triple: ${targetTriple}`)
    }
  } else {
    switch (targetTriple) {
      case "x86_64-unknown-linux-gnu":
        hostTriple = "x86_64-unknown-linux-gnu"
        break
      case "aarch64-unknown-linux-gnu":
        hostTriple = "x86_64-unknown-linux-gnu"
        break
      case "x86_64-unknown-linux-musl":
        hostTriple = "x86_64-unknown-linux-musl"
        break
      case "aarch64-unknown-linux-musl":
        hostTriple = "x86_64-unknown-linux-gnu"
        break
      default:
        throw new Error(`Unsupported target triple: ${targetTriple}`)
    }
  }

  const targetArch = targetTriple.split("-")[0]
  // Cross-compilation if arch differs OR if target is musl (musl binaries can't run on glibc host)
  const isCrossCompile = platform === "linux" &&
    (targetArch !== hostArch ||
      hostTriple.includes("gnu") && targetTriple.includes("-musl"))

  if (isCrossCompile) {
    console.log(`Cross-compiling: ${hostTriple} -> ${targetTriple}`)
  }

  // Set up compilers
  let cc: string
  let cxx: string
  let cmakePath: string
  let ninjaPath: string

  if (platform === "darwin") {
    cc = (await output("xcrun", ["-f", "clang"])).stdout.trim()
    cxx = (await output("xcrun", ["-f", "clang++"])).stdout.trim()

    const arch = Deno.build.arch
    const brewPrefix = arch === "aarch64" ? "/opt/homebrew" : "/usr/local"
    cmakePath = `${brewPrefix}/bin/cmake`
    ninjaPath = `${brewPrefix}/bin/ninja`
  } else if (platform === "linux") {
    const isMusl = targetTriple.includes("-musl")

    if (isMusl) {
      // Use clang with Thin LTO to avoid GCC bitcode (.ao) files
      cc = "clang"
      cxx = "clang++"
    } else {
      try {
        await exec("which", ["clang"])
        cc = "clang"
        cxx = "clang++"
      } catch {
        cc = "gcc"
        cxx = "g++"
      }
    }
    cmakePath = (await output("which", ["cmake"])).stdout.trim()
    ninjaPath = (await output("which", ["ninja"])).stdout.trim()
  } else {
    // Windows
    cmakePath = (await output("which", ["cmake"])).stdout.trim()
    ninjaPath = (await output("which", ["ninja"])).stdout.trim()
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
  await exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    version.replace(/^v/, ""),
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
    "-DSLEEF_BUILD_TESTS=OFF",
    "-DSLEEF_BUILD_DFT=OFF",
    "-DSLEEF_BUILD_INLINE_HEADERS=OFF",
    "-DSLEEF_ENABLE_TESTER4=OFF",
    "-DSLEEF_ENABLE_MPFR=OFF",
    "-DSLEEF_ENABLE_TLFLOAT=OFF",
    "-DSLEEF_ENABLE_SVE=OFF",
    "-DSLEEF_DISABLE_SSL=ON",
    "-DSLEEF_ENABLE_SSL=OFF",
  ]

  // Enable ARM-specific SIMD features for aarch64
  if (targetArch === "aarch64") {
    cmakeArgs.push("-DCMAKE_C_FLAGS=-march=armv8-a")
    cmakeArgs.push("-DCMAKE_CXX_FLAGS=-march=armv8-a")
  }

  if (platform === "darwin") {
    cmakeArgs.push("-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0")
  } else if (platform === "windows") {
    cmakeArgs.push("-DCMAKE_C_COMPILER=cl.exe")
    cmakeArgs.push("-DCMAKE_CXX_COMPILER=cl.exe")
  } else if (platform === "linux") {
    const isMusl = targetTriple.includes("-musl")

    if (isCrossCompile) {
      // Linux cross-compilation configuration
      cmakeArgs.push("-DCMAKE_SYSTEM_NAME=Linux")
      cmakeArgs.push(`-DCMAKE_SYSTEM_PROCESSOR=${targetArch}`)

      // Use cross-compiler for aarch64 glibc (musl compilers already set above)
      if (targetArch === "aarch64" && !isMusl) {
        cmakeArgs.push("-DCMAKE_C_COMPILER=aarch64-linux-gnu-gcc")
        cmakeArgs.push("-DCMAKE_CXX_COMPILER=aarch64-linux-gnu-g++")
      }

      // Point to native build directory for host tools
      const nativeBuildDir = path.join(
        repoRoot,
        `build/${hostTriple}/sleef`,
      )
      cmakeArgs.push(`-DNATIVE_BUILD_DIR=${nativeBuildDir}`)
    }

    // For musl targets, use clang with Thin LTO and cross-compiler sysroot
    if (isMusl) {
      const sysroot = targetArch === "aarch64"
        ? "/opt/aarch64-linux-musl-cross/aarch64-linux-musl"
        : "/opt/x86_64-linux-musl-cross/x86_64-linux-musl"
      const muslTarget = `${targetArch}-linux-musl`
      const archFlags = targetArch === "aarch64" ? " -march=armv8-a" : ""
      // GCC runtime library path for crtbeginT.o, crtend.o, libgcc.a, libgcc_eh.a
      const gccLibPath =
        `/opt/${targetArch}-linux-musl-cross/lib/gcc/${targetArch}-linux-musl/14.2.0`
      cmakeArgs.push(`-DCMAKE_SYSROOT=${sysroot}`)
      cmakeArgs.push(`-DCMAKE_C_COMPILER_TARGET=${muslTarget}`)
      cmakeArgs.push(`-DCMAKE_CXX_COMPILER_TARGET=${muslTarget}`)
      cmakeArgs.push(`-DCMAKE_C_FLAGS=-flto=thin -fPIC${archFlags}`)
      cmakeArgs.push(`-DCMAKE_CXX_FLAGS=-flto=thin -fPIC${archFlags}`)
      cmakeArgs.push(`-DCMAKE_EXE_LINKER_FLAGS=-L${gccLibPath} -flto=thin -fuse-ld=lld -static`)
      cmakeArgs.push("-DCMAKE_AR=/usr/bin/llvm-ar")
      cmakeArgs.push("-DCMAKE_RANLIB=/usr/bin/llvm-ranlib")
      cmakeArgs.push("-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY")
      cmakeArgs.push("-DCMAKE_FIND_ROOT_PATH_MODE_INCLUDE=ONLY")
    }
  }

  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=ON")
  }

  // Run CMake configuration
  console.log("Running CMake configuration...")
  await exec(cmakePath, cmakeArgs, { cwd: buildRoot })

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    if (platform === "darwin") {
      maxJobs = (await output("sysctl", ["-n", "hw.ncpu"])).stdout
        .trim()
    } else {
      try {
        maxJobs = (await output("nproc", [])).stdout.trim()
      } catch {
        maxJobs = "4"
      }
    }
  }

  // Build
  console.log(`Building SLEEF (${maxJobs} parallel jobs)`)
  await exec(
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

if (import.meta.main) {
  const { object } = await import("@optique/core/constructs")
  const { option, flag } = await import("@optique/core/primitives")
  const { string, choice } = await import("@optique/core/valueparser")
  const { withDefault, optional } = await import("@optique/core/modifiers")
  const { run } = await import("@optique/run")

  const parser = object({
    target: option("-t", "--target", string()),
    buildType: withDefault(
      option(
        "-b",
        "--build-type",
        choice(["Debug", "Release", "RelWithDebInfo", "MinSizeRel"]),
      ),
      "Release" as const,
    ),
    clean: withDefault(flag("-c", "--clean"), true),
    verbose: withDefault(flag("-v", "--verbose"), false),
    version: optional(option("--version", string())),
  })

  const args = run(parser)
  await buildSleef(args)
}
