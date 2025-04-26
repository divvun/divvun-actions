// build = [
//     (
//         "build",
//         GithubAction(
//             "actions-rs/cargo",
//             {
//                 "command": "build",
//                 "args": f"--release {features} --manifest-path {cargo_toml_path} --target i686-pc-windows-msvc --verbose",
//             },
//         ),
//     )
// ]
// dist = [
//     (
//         "dist",
//         GithubActionScript(
//             f"mkdir dist\\bin && move {target_dir}\\i686-pc-windows-msvc\\release\\{bin_name}.exe dist\\bin\\{rename_binary}.exe"
//         ),
//     )
// ]
// sign = [
//     (
//         "sign",
//         GithubAction(
//             "divvun/taskcluster-gha/codesign",
//             {"path": f"dist/bin/{rename_binary}.exe"},
//         ),
//     )
// ]
import * as builder from "~/builder.ts"

const TARGETS = [
  // "i686-pc-windows-msvc",
  "x86_64-pc-windows-msvc",
  "aarch64-pc-windows-msvc",
]

async function build() {
  for (const target of TARGETS) {
    await builder.group(`Building ${target}`, async () => {
      const proc = new Deno.Command("cargo", {
        args: ["build", "--release", "--target", target],
      })

      const status = await proc.spawn().status

      if (status.code !== 0) {
        throw new Error(`Process exited with code ${status.code}`)
      }
    })
  }
}
