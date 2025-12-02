import { buildExecutorchMacos } from "./build-executorch-macos.ts"
import { buildExecutorchIos } from "./build-executorch-ios.ts"
import { buildExecutorchAndroid } from "./build-executorch-android.ts"
import { buildExecutorchLinux } from "./build-executorch-linux.ts"
import { buildExecutorchWindows } from "./build-executorch-windows.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

export interface BuildExecutorchOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

export async function buildExecutorch(options: BuildExecutorchOptions) {
  const { target } = options

  // Route to appropriate build script based on target triple
  if (target === "aarch64-apple-darwin" || target === "x86_64-apple-darwin") {
    console.log("--- Building ExecuTorch for macOS")
    await buildExecutorchMacos(options)
  } else if (target === "aarch64-apple-ios") {
    console.log("--- Building ExecuTorch for iOS device")
    await buildExecutorchIos(options)
  } else if (target === "aarch64-apple-ios-sim") {
    console.log("--- Building ExecuTorch for iOS simulator (Apple Silicon)")
    await buildExecutorchIos({ ...options, simulator: "arm64" })
  } else if (target === "x86_64-apple-ios-sim") {
    console.log("--- Building ExecuTorch for iOS simulator (Intel)")
    await buildExecutorchIos({ ...options, simulator: "x86_64" })
  } else if (target === "aarch64-linux-android") {
    console.log("--- Building ExecuTorch for Android arm64-v8a")
    await buildExecutorchAndroid({ ...options, abi: "arm64-v8a" })
  } else if (target === "armv7-linux-androideabi") {
    console.log("--- Building ExecuTorch for Android armeabi-v7a")
    await buildExecutorchAndroid({ ...options, abi: "armeabi-v7a" })
  } else if (target === "x86_64-linux-android") {
    console.log("--- Building ExecuTorch for Android x86_64")
    await buildExecutorchAndroid({ ...options, abi: "x86_64" })
  } else if (target === "i686-linux-android") {
    console.log("--- Building ExecuTorch for Android x86")
    await buildExecutorchAndroid({ ...options, abi: "x86" })
  } else if (
    target === "x86_64-unknown-linux-gnu" ||
    target === "aarch64-unknown-linux-gnu" ||
    target === "x86_64-unknown-linux-musl" ||
    target === "aarch64-unknown-linux-musl"
  ) {
    console.log("--- Building ExecuTorch for Linux")
    await buildExecutorchLinux(options)
  } else if (
    target === "x86_64-pc-windows-msvc" ||
    target === "aarch64-pc-windows-msvc"
  ) {
    console.log("--- Building ExecuTorch for Windows")
    await buildExecutorchWindows(options)
  } else {
    throw new Error(`Unknown or unsupported target triple: ${target}`)
  }
}
