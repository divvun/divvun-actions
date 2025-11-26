import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { BuildProps } from "../../pipelines/lang/mod.ts"
import { setupGiellaCoreDependencies } from "./common.ts"

class Autotools {
  private directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  async makeBuildDir() {
    const proc = new Deno.Command("mkdir", {
      args: ["-p", "build"],
      cwd: this.directory,
    }).spawn()

    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to make build directory: ${status.code}`)
    }
  }

  async runAutogen() {
    const proc = new Deno.Command("bash", {
      args: ["-c", "./autogen.sh"],
      cwd: this.directory,
    }).spawn()

    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to run autogen: ${status.code}`)
    }
  }

  async runConfigure(flags: string[]) {
    const proc = new Deno.Command("bash", {
      args: ["-c", `../configure ${flags.join(" ")}`],
      cwd: path.join(this.directory, "build"),
    }).spawn()

    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to run configure: ${status.code}`)
    }
  }

  async runMake() {
    const proc = new Deno.Command("bash", {
      args: ["-c", "make -j$(nproc)"],
      cwd: path.join(this.directory, "build"),
    }).spawn()

    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to run make: ${status.code}`)
    }
  }

  async build(flags: string[]) {
    await this.makeBuildDir()
    await this.runAutogen()
    await this.runConfigure(flags)
    await this.runMake()
  }
}

export type Output = {
  ttsTextprocPaths: string[]
}

function deriveAutogenFlags(_config: BuildProps) {
  const flags = [
    "--without-forrest",
    "--disable-silent-rules",
    "--disable-spellers",
    "--disable-analysers",
    "--disable-generators",
    "--disable-transcriptors",
    "--enable-tts",
  ]

  return flags
}

export default async function langTtsTextprocBuild(
  buildConfig: BuildProps,
): Promise<Output> {
  logger.info("Building TTS text processor")
  logger.info(JSON.stringify(buildConfig, null, 2))

  await setupGiellaCoreDependencies()

  const flags = deriveAutogenFlags(buildConfig)
  const autotoolsBuilder = new Autotools(Deno.cwd())

  logger.debug(`Flags: ${flags}`)
  await autotoolsBuilder.build(flags)

  // Upload the build directory
  await builder.uploadArtifacts("build/**/*")

  // Glob the TTS files in the tts directory
  const out: string[] = []

  const files = await fs.expandGlob(
    path.join("build/tools/tts/*"),
    { followSymlinks: false },
  )

  for await (const file of files) {
    if (file.isFile) {
      out.push(path.join("build/tools/tts", path.basename(file.path)))
    }
  }

  if (out.length === 0) {
    throw new Error("No TTS text processor files found!")
  }

  logger.info("TTS text processor paths:")
  logger.info(JSON.stringify(out, null, 2))

  await builder.setMetadata("tts-textproc-paths", JSON.stringify(out))

  return {
    ttsTextprocPaths: out,
  }
}
