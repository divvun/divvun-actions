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

export type Output = Record<string, never>

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

  // Enable both spellers and grammar checkers
  // Grammar checkers need spellers to be built
  flags.push("--enable-spellers")
  flags.push("--disable-hfst-desktop-spellers")
  flags.push("--enable-hfst-mobile-speller")
  flags.push("--enable-grammarchecker")

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

export default async function langGrammarBuild(
  buildConfig: BuildProps,
): Promise<Output> {
  logger.info("Building grammar checkers")
  logger.info(JSON.stringify(buildConfig, null, 2))

  // Download and extract the speller workspace snapshot so that speller
  // artifacts are present with their original mtimes before we configure and
  // build. This prevents make from trying to rebuild speller targets.
  logger.info("Downloading speller workspace snapshot...")
  await builder.downloadArtifacts("workspace-speller.tar.gz", ".")
  logger.info("Extracting speller workspace snapshot")
  const extractProc = new Deno.Command("tar", {
    args: ["-xpf", "workspace-speller.tar.gz"],
    cwd: Deno.cwd(),
    stdout: "inherit",
    stderr: "inherit",
  }).spawn()
  const extractStatus = await extractProc.status
  if (extractStatus.code !== 0) {
    throw new Error(
      `tar extraction failed with exit code ${extractStatus.code}`,
    )
  }
  await Deno.remove("workspace-speller.tar.gz")

  await setupGiellaCoreDependencies()

  const flags = deriveAutogenFlags(buildConfig)
  await builder.setMetadata("grammar-configure-flags", flags.join(" "))
  const autotoolsBuilder = new Autotools(Deno.cwd())

  logger.debug(`Flags: ${flags}`)
  await autotoolsBuilder.build(flags)

  // Upload grammar files
  await builder.uploadArtifacts("build/tools/grammarcheckers/*.drb")
  await builder.uploadArtifacts("build/tools/grammarcheckers/*.zcheck")

  logger.info("Grammar checker build complete")

  return {}
}
