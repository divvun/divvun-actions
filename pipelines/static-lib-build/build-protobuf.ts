import * as path from "@std/path"
import * as builder from "~/builder.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

type Platform = "darwin" | "linux" | "windows"

export interface BuildProtobufOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

function convertProtobufVersionToTag(version: string): string {
  // Ensure version starts with 'v'
  return version.startsWith("v") ? version : `v${version}`
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

export async function buildProtobuf(options: BuildProtobufOptions) {
  const {
    target,
    buildType = "Release",
    clean = true,
    verbose = false,
    version = "33.0",
  } = options

  console.log("Building Protocol Buffers (libprotobuf)")

  const platform = detectPlatform(target)

  const repoRoot = Deno.cwd()
  const protobufSourceDir = path.join(repoRoot, "protobuf")
  const buildRoot = path.join(repoRoot, `target/${target}/build/protobuf`)
  const installPrefix = path.join(repoRoot, `target/${target}/protobuf`)

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
  console.log("=== Protobuf Build Configuration ===")
  console.log(`Target triple:      ${target}`)
  console.log(`Build type:         ${buildType}`)
  console.log(`Platform:           ${platform}`)
  console.log(`C compiler:         ${cc}`)
  console.log(`C++ compiler:       ${cxx}`)
  console.log(`Protobuf source:    ${protobufSourceDir}`)
  console.log(`Build directory:    ${buildRoot}`)
  console.log(`Install prefix:     ${installPrefix}`)
  console.log("======================================")
  console.log("")

  // Clone protobuf
  console.log("Removing existing protobuf directory (if any)...")
  try {
    await Deno.remove(protobufSourceDir, { recursive: true })
  } catch {
    // Ignore if doesn't exist
  }

  const protobufTag = convertProtobufVersionToTag(version)
  console.log(`Cloning Protocol Buffers from GitHub (tag ${protobufTag})...`)
  await builder.exec("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    protobufTag,
    "https://github.com/protocolbuffers/protobuf.git",
    protobufSourceDir,
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
    protobufSourceDir,
    "-GNinja",
    `-DCMAKE_MAKE_PROGRAM=${ninjaPath}`,
    `-DCMAKE_BUILD_TYPE=${buildType}`,
    `-DCMAKE_INSTALL_PREFIX=${installPrefix}`,
    `-DCMAKE_C_COMPILER=${cc}`,
    `-DCMAKE_CXX_COMPILER=${cxx}`,
    "-DCMAKE_CXX_STANDARD=17",
    "-Dprotobuf_BUILD_SHARED_LIBS=OFF",
    "-Dprotobuf_FORCE_FETCH_DEPENDENCIES=ON",
    "-DABSL_ENABLE_INSTALL=ON",
    "-DABSL_PROPAGATE_CXX_STD=ON",
    "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
    "-Dprotobuf_BUILD_TESTS=OFF",
    "-Dprotobuf_BUILD_EXAMPLES=OFF",
    "-Dprotobuf_BUILD_PROTOC_BINARIES=ON",
  ]

  if (platform === "darwin") {
    cmakeArgs.push("-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0")
  } else if (platform === "windows") {
    cmakeArgs.push("-DCMAKE_C_COMPILER=cl.exe")
    cmakeArgs.push("-DCMAKE_CXX_COMPILER=cl.exe")
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
        maxJobs = (await builder.output("nproc")).stdout.trim()
      } catch {
        maxJobs = "4"
      }
    }
  }

  // Build
  console.log(`Building with ${maxJobs} parallel jobs...`)
  await builder.exec(cmakePath, [
    "--build",
    ".",
    "--target",
    "install",
    "--",
    `-j${maxJobs}`,
  ], { cwd: buildRoot })

  // Copy Abseil libraries to sysroot
  console.log("Copying Abseil libraries to sysroot...")
  try {
    const findResult = await builder.output("find", [
      buildRoot,
      "-name",
      "libabsl_*.a",
    ])

    const abslLibs = findResult.stdout.trim().split("\n").filter((
      line: string,
    ) => line.length > 0)

    if (abslLibs.length > 0) {
      for (const lib of abslLibs) {
        await builder.exec("cp", ["-v", lib, path.join(installPrefix, "lib")])
      }
      console.log(`Copied ${abslLibs.length} Abseil libraries`)
    } else {
      console.log("Warning: No Abseil libraries found in build directory")
    }
  } catch (error) {
    console.log("Warning: Failed to copy Abseil libraries:", error)
  }

  // Copy Abseil headers if present
  console.log("Copying Abseil headers...")
  const abslHeaderPaths = [
    path.join(buildRoot, "abseil-cpp/absl"),
    path.join(buildRoot, "_deps/abseil-cpp-src/absl"),
  ]

  for (const abslPath of abslHeaderPaths) {
    try {
      await Deno.stat(abslPath)
      await builder.exec("cp", [
        "-rf",
        abslPath,
        path.join(installPrefix, "include"),
      ])
      console.log("Copied Abseil headers")
      break
    } catch {
      // Try next path
      continue
    }
  }

  console.log("")
  console.log("Protobuf build completed successfully!")
  console.log("")
  console.log(`Target: ${target}`)
  console.log("")
  console.log("Binaries:")
  try {
    const bins = await builder.output("ls", ["-lh"], {
      cwd: path.join(installPrefix, "bin"),
    })
    console.log(bins)
  } catch {
    console.log("  (protoc not found - check build output)")
  }
  console.log("")
  console.log("You can now use:")
  console.log(`  protoc: ${installPrefix}/bin/protoc`)
  console.log(`  libprotobuf.a: ${installPrefix}/lib/libprotobuf.a`)
  console.log(`  libabsl_*.a: ${installPrefix}/lib/libabsl_*.a`)
  console.log("")
}
