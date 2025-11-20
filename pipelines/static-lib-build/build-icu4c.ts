import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

type Platform = "darwin" | "ios" | "linux" | "android" | "windows"

export interface BuildIcu4cOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

function detectPlatform(target: string): Platform {
  if (target.includes("-apple-ios")) {
    return "ios"
  } else if (target.includes("-apple-darwin")) {
    return "darwin"
  } else if (target.includes("-linux-android")) {
    return "android"
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
    case "ios":
      return "MacOSX"
    case "linux":
      return "Linux"
    case "android":
      return "Linux"
    case "windows":
      return "MSYS/MSVC"
  }
}

function convertIcuVersionToTag(version: string): string {
  // Convert v77.1 or 77.1 to release-77-1
  const cleanVersion = version.replace(/^v/, "")
  return `release-${cleanVersion.replace(/\./g, "-")}`
}

export async function buildIcu4c(options: BuildIcu4cOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
    version = "77.1",
  } = options

  console.log("Building ICU (International Components for Unicode)")

  const platform = detectPlatform(target)
  const repoRoot = Deno.cwd()
  const installPrefix = path.join(repoRoot, `target/${target}/icu4c`)

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

  // Windows uses vcpkg for ICU installation
  if (platform === "windows") {
    const vcpkgRoot = Deno.env.get("VCPKG_ROOT")
    if (!vcpkgRoot) {
      throw new Error("VCPKG_ROOT environment variable not set")
    }

    // Clone or update the vcpkg overlay
    const overlayPath = path.join(repoRoot, "vcpkg-overlay")
    try {
      await Deno.stat(path.join(overlayPath, ".git"))
      console.log("Updating vcpkg overlay...")
      await builder.exec("git", ["pull"], { cwd: overlayPath })
    } catch {
      console.log("Cloning vcpkg overlay...")
      await builder.exec("git", [
        "clone",
        "https://github.com/divvun/vcpkg-overlay.git",
        overlayPath,
      ])
    }

    // Check if the correct version of ICU is already installed
    try {
      const result = await builder.output("vcpkg", ["list", "icu"])
      const installedVersion = result.stdout.match(
        /icu:x64-windows-static\s+([\d.]+)/,
      )?.[1]

      const targetVersion = version.replace(/^v/, "")

      if (installedVersion === targetVersion) {
        console.log(
          `ICU ${targetVersion} already installed in vcpkg, using cached version`,
        )
      } else {
        if (installedVersion) {
          console.log(
            `Found ICU ${installedVersion} but need ${targetVersion}, reinstalling...`,
          )
          await builder.exec("vcpkg", [
            "remove",
            "icu",
            "--triplet=x64-windows-static",
          ])
        }
        console.log(
          `Installing ICU ${targetVersion} with vcpkg using overlay...`,
        )
        await builder.exec("vcpkg", [
          "install",
          "icu",
          "--triplet=x64-windows-static",
          `--overlay-ports=${overlayPath}/ports`,
        ])
      }
    } catch {
      // vcpkg list failed, assume not installed
      console.log(`Installing ICU ${version} with vcpkg using overlay...`)
      await builder.exec("vcpkg", [
        "install",
        "icu",
        "--triplet=x64-windows-static",
        `--overlay-ports=${overlayPath}/ports`,
      ])
    }

    const vcpkgInstalled = path.join(
      vcpkgRoot,
      "packages/icu_x64-windows-static",
    )

    console.log("Copying ICU files...")

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
    const sdkroot = (await builder.output("xcrun", ["--show-sdk-path"])).stdout
      .trim()

    Deno.env.set("CC", cc)
    Deno.env.set("CXX", cxx)
    Deno.env.set("SDKROOT", sdkroot)
    Deno.env.set("MACOSX_DEPLOYMENT_TARGET", "11.0")
  } else if (platform === "ios") {
    // iOS: use clang with iOS SDK
    const cc = (await builder.output("xcrun", ["-f", "clang"])).stdout.trim()
    const cxx = (await builder.output("xcrun", ["-f", "clang++"])).stdout.trim()
    const sdkroot =
      (await builder.output("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]))
        .stdout
        .trim()

    Deno.env.set("CC", cc)
    Deno.env.set("CXX", cxx)
    Deno.env.set("SDKROOT", sdkroot)
    Deno.env.set("IPHONEOS_DEPLOYMENT_TARGET", "12.0")
  } else if (platform === "android") {
    // Android: use Android NDK toolchain
    const ndkPath = Deno.env.get("ANDROID_NDK_HOME") ||
      Deno.env.get("ANDROID_NDK")
    if (!ndkPath) {
      throw new Error(
        "ANDROID_NDK_HOME or ANDROID_NDK environment variable not set",
      )
    }
    const toolchainPath = `${ndkPath}/toolchains/llvm/prebuilt/linux-x86_64`
    const cc = `${toolchainPath}/bin/aarch64-linux-android21-clang`
    const cxx = `${toolchainPath}/bin/aarch64-linux-android21-clang++`

    Deno.env.set("CC", cc)
    Deno.env.set("CXX", cxx)
    Deno.env.set("AR", `${toolchainPath}/bin/llvm-ar`)
    Deno.env.set("RANLIB", `${toolchainPath}/bin/llvm-ranlib`)
    Deno.env.set("LD", `${toolchainPath}/bin/ld`)
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

    // Set cross-compilation flags for Linux
    if (isCrossCompile) {
      const crossFlags = `--target=${targetTriple} -fuse-ld=lld`
      Deno.env.set("CFLAGS", crossFlags)
      Deno.env.set("CXXFLAGS", crossFlags)
      Deno.env.set("LDFLAGS", "-fuse-ld=lld")
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

  const icuTag = convertIcuVersionToTag(version)
  console.log(`Cloning ICU from GitHub (tag ${icuTag})...`)
  await builder.exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    icuTag,
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

  // Platform-specific configuration
  if (platform === "ios") {
    // Patch ICU to recognize iOS as Darwin-based platform
    const acincludePath = path.join(icuSourceDir, "acinclude.m4")
    let acincludeContent = await Deno.readTextFile(acincludePath)
    acincludeContent = acincludeContent.replace(
      "*-apple-darwin*)",
      "*-apple-*)",
    )
    await Deno.writeTextFile(acincludePath, acincludeContent)
    console.log("Patched ICU to recognize iOS as Darwin platform")

    // Regenerate configure script with the patched acinclude.m4
    console.log("Regenerating configure script...")
    await builder.exec("autoconf", [], { cwd: icuSourceDir })

    // Also copy mh-darwin to mh-unknown for the build phase
    const mhDarwin = path.join(icuSourceDir, "config/mh-darwin")
    const mhUnknown = path.join(icuSourceDir, "config/mh-unknown")
    await Deno.copyFile(mhDarwin, mhUnknown)
    console.log("Copied mh-darwin to mh-unknown for iOS build")

    const hostBuildDir = path.join(
      repoRoot,
      "target/aarch64-apple-darwin/build/icu",
    )
    configureArgs.push("--host=aarch64-apple-ios")
    configureArgs.push(`--with-cross-build=${hostBuildDir}`)
    // Disable tools for iOS - they use system() which is not available on iOS
    configureArgs.push("--disable-tools")
    configureArgs.push("--disable-extras")
    configureArgs.push("--with-data-packaging=static")
    const sdkPath =
      (await builder.output("xcrun", ["--sdk", "iphoneos", "--show-sdk-path"]))
        .stdout.trim()
    const cflags =
      `-arch arm64 -miphoneos-version-min=12.0 -isysroot ${sdkPath}`
    const cxxflags =
      `-arch arm64 -miphoneos-version-min=12.0 -isysroot ${sdkPath}`
    Deno.env.set("CFLAGS", `${Deno.env.get("CFLAGS") || ""} ${cflags}`.trim())
    Deno.env.set(
      "CXXFLAGS",
      `${Deno.env.get("CXXFLAGS") || ""} ${cxxflags}`.trim(),
    )
  } else if (platform === "android") {
    const ndkPath = Deno.env.get("ANDROID_NDK_HOME") ||
      Deno.env.get("ANDROID_NDK")
    if (!ndkPath) {
      throw new Error(
        "ANDROID_NDK_HOME or ANDROID_NDK environment variable not set",
      )
    }
    const hostBuildDir = path.join(
      repoRoot,
      "target/x86_64-unknown-linux-gnu/build/icu",
    )
    configureArgs.push("--host=aarch64-linux-android")
    configureArgs.push(`--with-cross-build=${hostBuildDir}`)
    // Disable tools for Android - they won't run on Android anyway
    configureArgs.push("--disable-tools")
    configureArgs.push("--disable-extras")
    configureArgs.push("--with-data-packaging=static")
    // Note: We don't need to set CFLAGS/CXXFLAGS here since the NDK compiler
    // already knows the correct target and sysroot from its name (aarch64-linux-android21-clang)
  } else if (isCrossCompile) {
    // Linux cross-compilation
    const hostBuildDir = path.join(
      repoRoot,
      `target/${hostTriple}/build/icu`,
    )
    configureArgs.push(`--host=${targetTriple}`)
    configureArgs.push(`--with-cross-build=${hostBuildDir}`)
    // Note: CFLAGS/CXXFLAGS/LDFLAGS were already set above with --target and -fuse-ld=lld
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

  // For cross-compilation (iOS/Android), always use configure directly
  // runConfigureICU doesn't handle cross-compilation well
  if (platform === "ios" || platform === "android") {
    console.log("Cross-compiling: using configure directly")
    await builder.exec(
      path.join(icuSourceDir, "configure"),
      configureArgs,
      { cwd: buildRoot },
    )
  } else if (hasRunConfigureIcu) {
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
