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
  spellerPaths: {
    mobile: {
      [key: string]: string
    }
    desktop: {
      [key: string]: string
    }
  }
}

function deriveAutogenFlags(config: BuildProps) {
  const flags = [
    "--without-forrest",
    "--disable-silent-rules",
  ]

  if (config.generators) {
    flags.push("--enable-generators")
  }

  if (!config.analysers) {
    flags.push("--disable-analysers")
    flags.push("--disable-generators")
    flags.push("--disable-transcriptors")
  }

  if (config.hyphenators) {
    flags.push("--enable-fst-hyphenator")
  }

  // Enable spellers but NOT grammar checkers
  flags.push("--enable-spellers")
  flags.push("--disable-hfst-desktop-spellers")
  flags.push("--enable-hfst-mobile-speller")

  // Language-specific optimisations
  if (config.hyperminimalisation) {
    flags.push("--enable-hyperminimalisation")
  }

  if (config["reversed-intersect"]) {
    flags.push("--enable-reversed-intersect")
  }

  if (config["two-step-intersect"]) {
    flags.push("--enable-twostep-intersect")
  }

  if (config["backend-format"]) {
    flags.push(`--with-backend-format=${config["backend-format"]}`)
  }

  if (config["minimised-spellers"]) {
    flags.push("--enable-minimised-spellers")
  }

  return flags
}

export default async function langSpellerBuild(
  buildConfig: BuildProps,
): Promise<Output> {
  logger.info("Building spellers only")
  logger.info(JSON.stringify(buildConfig, null, 2))

  await setupGiellaCoreDependencies()

  const flags = deriveAutogenFlags(buildConfig)
  const autotoolsBuilder = new Autotools(Deno.cwd())

  logger.debug(`Flags: ${flags}`)
  await autotoolsBuilder.build(flags)

  // Upload the build directory
  await builder.uploadArtifacts("build/**/*")

  // Glob the zhfst files made available in the spellcheckers directory.
  // Associate their prefixes as their lang code.
  const out: {
    mobile: { [key: string]: string }
    desktop: { [key: string]: string }
  } = {
    mobile: {},
    desktop: {},
  }

  const files = await fs.expandGlob(
    path.join("build/tools/spellcheckers/*.zhfst"),
    { followSymlinks: false },
  )

  let hasSomeItems = false

  for await (const file of files) {
    const candidate = file.path

    if (candidate.endsWith("-mobile.zhfst")) {
      const v = path.basename(candidate).split("-mobile.zhfst")[0]
      out.mobile[v] = path.join(
        "build/tools/spellcheckers",
        path.basename(path.resolve(candidate)),
      )
      hasSomeItems = true
    }

    if (candidate.endsWith("-desktop.zhfst")) {
      const v = path.basename(candidate).split("-desktop.zhfst")[0]
      out.desktop[v] = path.join(
        "build/tools/spellcheckers",
        path.basename(path.resolve(candidate)),
      )
      hasSomeItems = true
    }
  }

  if (!hasSomeItems) {
    throw new Error("No speller files found!")
  }

  logger.info("Speller paths:")
  logger.info(JSON.stringify(out, null, 2))

  await builder.setMetadata("speller-paths", JSON.stringify(out))

  return {
    spellerPaths: out,
  }
}
