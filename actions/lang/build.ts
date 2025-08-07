import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

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

// async function deriveInputs(inputs: string[]): Promise<{ [key: string]: any }> {
//   const o: { [key: string]: any } = {}

//   for (const kebabInput of inputs) {
//     const value: any = await builder.getInput(kebabInput)
//     const input = camelCase(kebabInput)

//     logger.info(input, value)

//     if (typeof value === "string") {
//       if (value.includes(",")) {
//         o[input] = value.split(",").map((x) => x.trim())
//       } else if (value === "false") {
//         o[input] = false
//       } else if (value === "true") {
//         o[input] = true
//       } else if (value === "") {
//         // Do nothing.
//       } else {
//         o[input] = value
//       }
//     }
//   }

//   return o
// }

export type Props = {
  requiresDesktopAsMobileWorkaround: boolean
  fst: string[]
  generators: boolean
  spellers: boolean
  hyphenators: boolean
  analysers: boolean
  grammarCheckers: boolean
  hyperminimalisation: boolean
  reversedIntersect: boolean
  twoStepIntersect: boolean
  spellerOptimisation: boolean
  backendFormat: string | null
  minimisedSpellers: boolean
  forceAllTools: boolean
}

export type Output = {
  spellerPaths: {
    mobile: {
      [key: string]: string
    }
    desktop: {
      [key: string]: string
    }
  } | null
}

export default async function langBuild({
  requiresDesktopAsMobileWorkaround,
  ...config
}: Props): Promise<Output> {
  logger.info(JSON.stringify(config, null, 2))

  // Check ../giella-core and ../shared-mul
  const giellaCorePath = path.join(Deno.cwd(), "..", "giella-core")
  if (await fs.exists(giellaCorePath)) {
    // git pull
    const proc = new Deno.Command("git", {
      args: ["pull"],
      cwd: giellaCorePath,
    }).spawn()
    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to update giella-core: ${status.code}`)
    }
  }

  const sharedMulPath = path.join(Deno.cwd(), "..", "shared-mul")
  if (await fs.exists(sharedMulPath)) {
    // git pull
    const proc = new Deno.Command("git", {
      args: ["pull"],
      cwd: sharedMulPath,
    }).spawn()
    const status = await proc.status
    if (status.code !== 0) {
      throw new Error(`Failed to update shared-mul: ${status.code}`)
    }
  }

  const flags = [
    "--without-forrest",
    "--disable-silent-rules",
    "--without-xfst",
  ]

  // General configuration

  // if (config.fst.includes("foma")) {
  //   flags.push("--with-foma")
  // }

  // if (!config.fst.includes("hfst")) {
  //   flags.push("--without-hfst")
  // }

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

  if (config.spellers || config.grammarCheckers) {
    flags.push("--enable-spellers")
    flags.push("--disable-hfst-desktop-spellers")
    flags.push("--enable-hfst-mobile-speller")
  }

  if (config.grammarCheckers) {
    flags.push("--enable-grammarchecker")
  }

  // Language-specific optimisations

  if (config.hyperminimalisation) {
    flags.push("--enable-hyperminimalisation")
  }

  if (config.reversedIntersect) {
    flags.push("--enable-reversed-intersect")
  }

  if (config.twoStepIntersect) {
    flags.push("--enable-twostep-intersect")
  }

  if (config.backendFormat) {
    flags.push(`--with-backend-format=${config.backendFormat}`)
  }

  if (config.minimisedSpellers) {
    flags.push("--enable-minimised-spellers")
  }

  const autotoolsBuilder = new Autotools(Deno.cwd())

  logger.debug(`Flags: ${flags}`)
  await autotoolsBuilder.build(flags)

  if (config.spellers) {
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
        out.mobile[v] = path.join("build/tools/spellcheckers", path.basename(path.resolve(candidate)))
        hasSomeItems = true
      }

      if (candidate.endsWith("-desktop.zhfst")) {
        const v = path.basename(candidate).split("-desktop.zhfst")[0]
        out.desktop[v] = path.join("build/tools/spellcheckers", path.basename(path.resolve(candidate)))
        hasSomeItems = true
      }
    }

    if (!hasSomeItems) {
      throw new Error("Did not find any ZHFST files.")
    }

    if (requiresDesktopAsMobileWorkaround) {
      logger.warning(
        "WORKAROUND: FORCING DESKTOP SPELLERS AS MOBILE SPELLERS.",
      )
      for (const [key, value] of Object.entries(out.desktop)) {
        if (out.mobile[key] == null) {
          out.mobile[key] = value
        }
      }
    }

    logger.info("Saving speller-paths")

    logger.info("Setting speller paths to:")
    logger.info(JSON.stringify(out, null, 2))

    await builder.uploadArtifacts("build/tools/spellcheckers/*.zhfst")
    await builder.setMetadata("speller-paths", JSON.stringify(out, null, 0))

    return {
      spellerPaths: out,
    }
  } else {
    logger.info("Not setting speller paths.")
  }

  return { spellerPaths: null }
}

// async function run() {
//   const requiresDesktopAsMobileWorkaround = Boolean(
//     await builder.getInput("force-desktop-spellers-as-mobile"),
//   )

//   const config = await deriveInputs([
//     "fst",
//     "generators",
//     "spellers",
//     "hyphenators",
//     "analysers",
//     "grammar-checkers",
//     "hyperminimalisation",
//     "reversed-intersect",
//     "two-step-intersect",
//     "speller-optimisation",
//     "backend-format",
//     "force-all-tools",
//     "minimised-spellers",
//   ])

//   const props = {
//     requiresDesktopAsMobileWorkaround,
//     ...config,
//   } as Props

//   const { spellerPaths: out } = await langBuild(props)

//   if (out != null) {
//     await builder.setOutput("speller-paths", JSON.stringify(out, null, 0))
//   }
// }
