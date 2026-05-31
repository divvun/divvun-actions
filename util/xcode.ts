import * as builder from "~/builder.ts"

export async function logXcodeVersion() {
  await builder.group("Xcode toolchain", async () => {
    await builder.exec("xcode-select", ["-p"])
    await builder.exec("xcodebuild", ["-version"])
  })
}

/** Run xcodebuild with its stdout streamed through xcbeautify. */
export async function xcodebuild(args: string[]) {
  const xcb = new Deno.Command("xcodebuild", {
    args,
    stdout: "piped",
    stderr: "inherit",
  }).spawn()

  const beautify = new Deno.Command("xcbeautify", {
    stdin: "piped",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()

  // pipeTo drains xcodebuild's stdout into xcbeautify and closes its stdin on EOF.
  await xcb.stdout.pipeTo(beautify.stdin)

  const status = await xcb.status
  await beautify.status

  if (!status.success) {
    throw new Error(`xcodebuild exited with code ${status.code}`)
  }
}
