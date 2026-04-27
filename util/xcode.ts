import * as builder from "~/builder.ts"

export async function logXcodeVersion() {
  await builder.group("Xcode toolchain", async () => {
    await builder.exec("xcode-select", ["-p"])
    await builder.exec("xcodebuild", ["-version"])
  })
}
