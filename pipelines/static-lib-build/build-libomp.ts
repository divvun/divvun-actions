import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

type Platform = "darwin" | "linux" | "windows"

export interface BuildLibompOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

function convertLibompVersionToTag(version: string): string {
  // Convert v21.1.4 or 21.1.4 to llvmorg-21.1.4
  const cleanVersion = version.replace(/^v/, "")
  return `llvmorg-${cleanVersion}`
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

export async function buildLibomp(options: BuildLibompOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
    version = "21.1.4",
  } = options

  console.log("Building LLVM OpenMP Runtime (libomp)")

  const platform = detectPlatform(target)

  if (platform === "windows") {
    console.log(
      "Warning: Static OpenMP is not officially supported on Windows",
    )
  }

  const repoRoot = Deno.cwd()
  const llvmProjectDir = path.join(repoRoot, "llvm-project")
  const buildRoot = path.join(repoRoot, `build/${target}/openmp`)
  const installPrefix = path.join(repoRoot, `target/${target}/libomp`)

  // Detect cross-compilation
  const targetTriple = target
  const hostArch = Deno.build.arch
  // Detect if host is Alpine (musl) by checking for /etc/alpine-release
  const isAlpine = Deno.build.os === "linux" &&
    (await Deno.stat("/etc/alpine-release").catch(() => null)) !== null
  const hostTriple = hostArch === "aarch64"
    ? (isAlpine ? "aarch64-unknown-linux-musl" : "aarch64-unknown-linux-gnu")
    : (isAlpine ? "x86_64-unknown-linux-musl" : "x86_64-unknown-linux-gnu")
  const targetArch = targetTriple.split("-")[0]
  // Cross-compilation if target differs from host (arch or libc)
  const isCrossCompile = platform === "linux" && targetTriple !== hostTriple

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
    const isMusl = targetTriple.includes("-musl")

    if (isMusl) {
      // Use musl-clang wrapper scripts
      const scriptsDir = path.join(import.meta.dirname!, "../../scripts")
      cc = `${scriptsDir}/${targetArch}-linux-musl-clang`
      cxx = `${scriptsDir}/${targetArch}-linux-musl-clang++`
    } else {
      try {
        await builder.exec("which", ["clang"])
        cc = "clang"
        cxx = "clang++"
      } catch {
        cc = "gcc"
        cxx = "g++"
      }
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
  console.log("=== OpenMP Build Configuration ===")
  console.log(`Target triple:      ${target}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Platform:           ${platform}`)
  console.log(`C compiler:         ${cc}`)
  console.log(`C++ compiler:       ${cxx}`)
  console.log(`LLVM source:        ${llvmProjectDir}`)
  console.log(`Build directory:    ${buildRoot}`)
  console.log(`Install prefix:     ${installPrefix}`)
  console.log("======================================")
  console.log("")

  // Clone LLVM project
  console.log("Removing existing LLVM project directory (if any)...")
  try {
    await Deno.remove(llvmProjectDir, { recursive: true })
  } catch {
    // Ignore if doesn't exist
  }

  const llvmTag = convertLibompVersionToTag(version)
  console.log(`Cloning LLVM project (tag ${llvmTag})...`)
  await builder.exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    llvmTag,
    "https://github.com/llvm/llvm-project.git",
    llvmProjectDir,
  ])

  // Clean build directory if requested
  if (clean) {
    console.log("Cleaning build directory...")
    try {
      await Deno.remove(buildRoot, { recursive: true })
    } catch {
      // Ignore if doesn't exist
    }
  }

  await Deno.mkdir(buildRoot, { recursive: true })

  // Prepare CMake arguments
  const cmakeArgs = [
    path.join(llvmProjectDir, "openmp"),
    "-GNinja",
    `-DCMAKE_MAKE_PROGRAM=${ninjaPath}`,
    `-DCMAKE_BUILD_TYPE=${buildType}`,
    `-DCMAKE_INSTALL_PREFIX=${installPrefix}`,
    "-DCMAKE_CXX_STANDARD=17",
    `-DCMAKE_C_COMPILER=${cc}`,
    `-DCMAKE_CXX_COMPILER=${cxx}`,
    "-DLIBOMP_ENABLE_SHARED=OFF",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    "-DOPENMP_ENABLE_TESTING=OFF",
    "-DLIBOMP_OMPT_SUPPORT=OFF",
  ]

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

      if (!isMusl) {
        // Only use clang-specific flags for glibc cross-compilation
        cmakeArgs.push(`-DCMAKE_C_COMPILER_TARGET=${targetTriple}`)
        cmakeArgs.push(`-DCMAKE_CXX_COMPILER_TARGET=${targetTriple}`)
        cmakeArgs.push(`-DCMAKE_ASM_COMPILER_TARGET=${targetTriple}`)
        cmakeArgs.push(`-DCMAKE_ASM_FLAGS=--target=${targetTriple}`)
        cmakeArgs.push("-DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=lld")
        cmakeArgs.push("-DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=lld")
      }
    }

    // For musl targets, wrapper scripts handle sysroot/target/library paths
    if (isMusl) {
      cmakeArgs.push("-DCMAKE_C_FLAGS=-flto=thin -fPIC")
      cmakeArgs.push("-DCMAKE_CXX_FLAGS=-flto=thin -fPIC")
      cmakeArgs.push("-DCMAKE_EXE_LINKER_FLAGS=-flto=thin -fuse-ld=lld -static")
      cmakeArgs.push("-DCMAKE_AR=/usr/lib/llvm21/bin/llvm-ar")
      cmakeArgs.push("-DCMAKE_RANLIB=/usr/lib/llvm21/bin/llvm-ranlib")
    }
  }

  if (verbose) {
    cmakeArgs.push("-DCMAKE_VERBOSE_MAKEFILE=ON")
  }

  // Run CMake configuration
  console.log("Running CMake configuration...")
  Deno.env.set("MSYS_NO_PATHCONV", "1")
  Deno.env.set("MSYS2_ARG_CONV_EXCL", "*")

  await builder.exec(cmakePath, cmakeArgs, { cwd: buildRoot })

  Deno.env.delete("MSYS_NO_PATHCONV")
  Deno.env.delete("MSYS2_ARG_CONV_EXCL")

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    if (platform === "darwin") {
      maxJobs = (await builder.output("sysctl", ["-n", "hw.ncpu"])).stdout
        .trim()
    } else {
      try {
        maxJobs = (await builder.output("nproc")).stdout.trim()
      } catch {
        maxJobs = "4"
      }
    }
  }

  // Build
  console.log(`Building with ${maxJobs} parallel jobs...`)
  Deno.env.set("MSYS_NO_PATHCONV", "1")
  Deno.env.set("MSYS2_ARG_CONV_EXCL", "*")

  await builder.exec(cmakePath, [
    "--build",
    ".",
    "--target",
    "install",
    "--",
    `-j${maxJobs}`,
  ], { cwd: buildRoot })

  Deno.env.delete("MSYS_NO_PATHCONV")
  Deno.env.delete("MSYS2_ARG_CONV_EXCL")

  console.log("")
  console.log("OpenMP build completed successfully!")
  console.log("")
  console.log(`Target: ${target}`)
  console.log("")
  console.log("Library files:")
  try {
    const libs = await builder.output("ls", ["-lh"], {
      cwd: path.join(installPrefix, "lib"),
    })
    console.log(libs)
  } catch {
    console.log("  (none found - check build output)")
  }
  console.log("")
  console.log(`You can now link against: ${installPrefix}/lib/libomp.a`)
  console.log("")
}
