import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { download } from "~/util/download.ts"
import { makeTempDir } from "~/util/temp.ts"
import { versions } from "~/docker/versions.ts"

const OXT_ARTIFACT = "divvunspell-libreoffice-linux-x86_64.oxt"

export async function runLibreOfficeExtensionLinuxOxt() {
  const runtimeVersion = versions.divvunRuntime
  const targetTriple = "x86_64-unknown-linux-gnu"
  using stage = await makeTempDir({ prefix: "divvun-runtime-lib-" })

  await builder.group("Downloading divvun-runtime static lib", async () => {
    const archiveName =
      `libdivvun_runtime-${targetTriple}-v${runtimeVersion}.tar.xz`
    const url =
      `https://github.com/divvun/divvun-runtime/releases/download/v${runtimeVersion}/${archiveName}`
    const archivePath = await download(url, { path: stage.path })
    await builder.exec("tar", ["-xJf", archivePath, "-C", stage.path])
  })

  const outputPath = path.resolve(OXT_ARTIFACT)
  const libRoot = path.join(stage.path, `libdivvun_runtime-${targetTriple}`)

  await builder.group("Building .oxt", async () => {
    await builder.exec("./make-oxt-linux.sh", [], {
      env: {
        DIVVUN_RUNTIME_LIB: libRoot,
        OUTPUT_OXT: outputPath,
      },
    })
  })

  await builder.group("Uploading .oxt", async () => {
    await builder.uploadArtifacts(outputPath)
  })
}
