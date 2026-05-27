import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeTempDir } from "~/util/temp.ts"
import { downloadDivvunRuntimeLib } from "./runtime-dep.ts"

const OXT_ARTIFACT = "divvunspell-libreoffice-linux-x86_64.oxt"

export async function runLibreOfficeExtensionLinuxOxt() {
  const target = "x86_64-unknown-linux-gnu"
  using stage = await makeTempDir({ prefix: "divvun-runtime-lib-" })

  await builder.group("Downloading divvun-runtime lib", async () => {
    const archivePath = await downloadDivvunRuntimeLib(target, stage.path)
    await builder.exec("tar", ["-xJf", archivePath, "-C", stage.path])
  })

  const extracted = path.join(stage.path, `libdivvun_runtime-${target}`)
  const fakeRuntimeDir = path.join(stage.path, "divvun-runtime-stub")
  await Deno.mkdir(fakeRuntimeDir, { recursive: true })
  const xPath = path.join(fakeRuntimeDir, "x")
  await Deno.writeTextFile(xPath, "#!/bin/sh\nexit 0\n")
  await Deno.chmod(xPath, 0o755)

  await builder.group("Building .oxt", async () => {
    await builder.exec("./make-oxt-linux.sh", [], {
      env: {
        DIVVUN_RUNTIME_DIR: fakeRuntimeDir,
        RUNTIME_LIB: path.join(extracted, "lib"),
        RUNTIME_INC: path.join(extracted, "include"),
      },
    })
  })

  await builder.group("Uploading .oxt", async () => {
    await Deno.rename("linux.oxt", OXT_ARTIFACT)
    await builder.uploadArtifacts(OXT_ARTIFACT)
  })
}
