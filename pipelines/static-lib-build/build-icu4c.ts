import * as path from "@std/path"
import * as fs from "@std/fs"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

type Platform = "darwin" | "linux" | "windows"

export interface BuildIcu4cOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
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

function getIcuPlatform(platform: Platform): string {
  switch (platform) {
    case "darwin":
      return "MacOSX"
    case "linux":
      return "Linux"
    case "windows":
      return "MSYS/MSVC"
  }
}

export async function buildIcu4c(options: BuildIcu4cOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
  } = options

  console.log("Building ICU (International Components for Unicode)")

  const platform = detectPlatform(target)
  const scriptDir = path.dirname(import.meta.filename!)
  const repoRoot = path.join(scriptDir, "../..")
  const installPrefix = path.join(repoRoot, `target/${target}/icu4c`)

  // Windows uses vcpkg for ICU installation
  if (platform === "windows") {
    console.log("Installing ICU with vcpkg...")
    await builder.exec("vcpkg", ["install", "icu:x64-windows-static"])

    console.log("Copying ICU files...")
    const vcpkgRoot = Deno.env.get("VCPKG_ROOT")
    if (!vcpkgRoot) {
      throw new Error("VCPKG_ROOT environment variable not set")
    }

    const vcpkgInstalled = path.join(vcpkgRoot, "packages/icu_x64-windows-static")

    // Create output directories
    await fs.ensureDir(path.join(installPrefix, "lib"))
    await fs.ensureDir(path.join(installPrefix, "include"))

    // Copy files
    await fs.copy(
      path.join(vcpkgInstalled, "lib"),
      path.join(installPrefix, "lib"),
      { overwrite: true },
    )
    await fs.copy(
      path.join(vcpkgInstalled, "include"),
      path.join(installPrefix, "include"),
      { overwrite: true },
    )

    console.log("ICU build completed successfully!")
    console.log(`Target: ${target}`)
    console.log(`Install prefix: ${installPrefix}`)
    return
  }

  // For non-Windows platforms, use configure/make build
  const icuPlatform = getIcuPlatform(platform)
  const icuSourceDir = path.join(repoRoot, "icu/icu4c/source")
  const buildRoot = path.join(repoRoot, `target/${target}/build/icu`)

  // Set up compilers
  if (platform === "darwin") {
    // macOS: use clang from Xcode
    const cc = (await builder.output("xcrun", ["-f", "clang"])).stdout.trim()
    const cxx = (await builder.output("xcrun", ["-f", "clang++"])).stdout.trim()
    const sdkroot = (await builder.output("xcrun", ["--show-sdk-path"])).stdout.trim()

    Deno.env.set("CC", cc)
    Deno.env.set("CXX", cxx)
    Deno.env.set("SDKROOT", sdkroot)
    Deno.env.set("MACOSX_DEPLOYMENT_TARGET", "11.0")
  } else if (platform === "linux") {
    // Linux: prefer clang if available
    try {
      await builder.exec("which", ["clang"])
      Deno.env.set("CC", "clang")
      Deno.env.set("CXX", "clang++")
    } catch {
      Deno.env.set("CC", "gcc")
      Deno.env.set("CXX", "g++")
    }
  }

  // Set build flags
  let cflagsOpt: string
  let cxxflagsOpt: string

  switch (buildType) {
    case "Debug":
      cflagsOpt = "-O0 -g"
      cxxflagsOpt = "-O0 -g"
      break
    case "Release":
      cflagsOpt = "-O3"
      cxxflagsOpt = "-O3"
      break
    case "RelWithDebInfo":
      cflagsOpt = "-O2 -g"
      cxxflagsOpt = "-O2 -g"
      break
    case "MinSizeRel":
      cflagsOpt = "-Os"
      cxxflagsOpt = "-Os"
      break
  }

  Deno.env.set("CFLAGS", cflagsOpt)
  Deno.env.set("CXXFLAGS", cxxflagsOpt)

  console.log("")
  console.log("=== ICU Build Configuration ===")
  console.log(`Target triple:      ${target}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Platform:           ${platform}`)
  console.log(`ICU platform:       ${icuPlatform}`)
  console.log(`ICU source:         ${icuSourceDir}`)
  console.log(`Build directory:    ${buildRoot}`)
  console.log(`Install prefix:     ${installPrefix}`)
  console.log("===================================")
  console.log("")

  // Clone ICU
  console.log("Removing existing ICU directory (if any)...")
  try {
    await Deno.remove(path.join(repoRoot, "icu"), { recursive: true })
  } catch {
    // Ignore if doesn't exist
  }

  console.log("Cloning ICU from GitHub (tag release-77-1)...")
  await builder.exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    "release-77-1",
    "https://github.com/unicode-org/icu.git",
    path.join(repoRoot, "icu"),
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

  // Configure
  console.log("Running ICU configure...")
  const configureArgs = [
    "--enable-static",
    "--disable-shared",
    "--disable-tests",
    "--disable-samples",
    `--prefix=${installPrefix}`,
  ]

  if (verbose) {
    configureArgs.push("--enable-debug")
  }

  // Check if runConfigureICU exists
  const runConfigureIcu = path.join(icuSourceDir, "runConfigureICU")
  let hasRunConfigureIcu = false
  try {
    await Deno.stat(runConfigureIcu)
    hasRunConfigureIcu = true
  } catch {
    hasRunConfigureIcu = false
  }

  if (hasRunConfigureIcu) {
    console.log(`Using runConfigureICU for platform: ${icuPlatform}`)
    await builder.exec(
      runConfigureIcu,
      [icuPlatform, ...configureArgs],
      { cwd: buildRoot },
    )
  } else {
    console.log("Using configure directly")
    await builder.exec(
      path.join(icuSourceDir, "configure"),
      configureArgs,
      { cwd: buildRoot },
    )
  }

  // Determine number of parallel jobs
  let maxJobs = Deno.env.get("MAX_JOBS")
  if (!maxJobs) {
    if (platform === "darwin") {
      maxJobs = (await builder.output("sysctl", ["-n", "hw.ncpu"])).stdout.trim()
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
  await builder.exec("make", [`-j${maxJobs}`], { cwd: buildRoot })

  // Install
  console.log(`Installing to ${installPrefix}...`)
  await builder.exec("make", ["install"], { cwd: buildRoot })

  console.log("")
  console.log("ICU build completed successfully!")
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
    console.log("  (libraries not found - check build output)")
  }
  console.log("")
  console.log("You can now link against ICU static libraries:")
  console.log("  libicuuc.a  - Unicode Common")
  console.log("  libicui18n.a - Internationalization")
  console.log("  libicudata.a - ICU Data")
  console.log("  libicuio.a  - ICU I/O (optional)")
  console.log("")
}
