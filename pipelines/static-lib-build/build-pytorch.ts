import { buildPytorchMacos } from "./build-pytorch-macos.ts"
import { buildPytorchIos } from "./build-pytorch-ios.ts"
import { buildPytorchAndroid } from "./build-pytorch-android.ts"
import { buildPytorchLinux } from "./build-pytorch-linux.ts"

type BuildType = "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel"

export interface BuildPytorchOptions {
  target: string
  buildType?: BuildType
  clean?: boolean
  verbose?: boolean
  version?: string
}

export async function buildPytorch(options: BuildPytorchOptions) {
  const { target } = options

  // Route to appropriate build script based on target triple
  if (target === "aarch64-apple-darwin" || target === "x86_64-apple-darwin") {
    console.log("--- Building PyTorch for macOS")
    await buildPytorchMacos(options)
  } else if (target === "aarch64-apple-ios") {
    console.log("--- Building PyTorch for iOS device")
    await buildPytorchIos(options)
  } else if (target === "aarch64-apple-ios-sim") {
    console.log("--- Building PyTorch for iOS simulator (Apple Silicon)")
    await buildPytorchIos({ ...options, simulator: "arm64" })
  } else if (target === "x86_64-apple-ios-sim") {
    console.log("--- Building PyTorch for iOS simulator (Intel)")
    await buildPytorchIos({ ...options, simulator: "x86_64" })
  } else if (target === "arm64_32-apple-watchos") {
    console.log("--- Building PyTorch for watchOS")
    await buildPytorchIos({ ...options, watchos: true })
  } else if (target === "aarch64-linux-android") {
    console.log("--- Building PyTorch for Android arm64-v8a")
    await buildPytorchAndroid({ ...options, abi: "arm64-v8a" })
  } else if (target === "armv7-linux-androideabi") {
    console.log("--- Building PyTorch for Android armeabi-v7a")
    await buildPytorchAndroid({ ...options, abi: "armeabi-v7a" })
  } else if (target === "x86_64-linux-android") {
    console.log("--- Building PyTorch for Android x86_64")
    await buildPytorchAndroid({ ...options, abi: "x86_64" })
  } else if (target === "i686-linux-android") {
    console.log("--- Building PyTorch for Android x86")
    await buildPytorchAndroid({ ...options, abi: "x86" })
  } else if (
    target === "x86_64-unknown-linux-gnu" ||
    target === "aarch64-unknown-linux-gnu"
  ) {
    console.log("--- Building PyTorch for Linux")
    await buildPytorchLinux(options)
  } else {
    throw new Error(`Unknown or unsupported target triple: ${target}`)
  }
}
