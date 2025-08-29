import * as path from "@std/path"
import logger from "~/util/log.ts"
import { isMatchingTag, Kbdgen, PahkatPrefix } from "~/util/shared.ts"
import { makeInstaller } from "../../inno-setup/lib.ts"
import { KeyboardType } from "../types.ts"
import { generateKbdInnoFromBundle } from "./iss.ts"

// Taken straight from semver.org, with added 'v'
const SEMVER_TAG_RE =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export type Props = {
  keyboardType: KeyboardType
  nightlyChannel: string
  bundlePath: string
}

export type Output = {
  channel: string | null
  payloadPath: string
}

export default async function keyboardBuild({
  keyboardType,
  nightlyChannel,
  bundlePath,
}: Props): Promise<Output> {
  // Testing how to get name and description fields
  const project = await Kbdgen.loadProjectBundle(bundlePath)
  const locales = project.locales
  logger.debug("TESTING: NAMES AND DESCRIPTIONS FROM project.yaml:")
  for (const locale in locales) {
    logger.debug(`  ${locales[locale].name}`)
    logger.debug(`  ${locales[locale].description}`)
  }

  if (
    keyboardType === KeyboardType.iOS ||
    keyboardType === KeyboardType.Android
  ) {
    throw new Error(
      `Unsupported keyboard type for non-meta build: ${keyboardType}`,
    )
  }

  let payloadPath
  let channel: string | null = null

  if (keyboardType === KeyboardType.MacOS) {
    if (isMatchingTag(SEMVER_TAG_RE)) {
      logger.debug("Using version from kbdgen project")
    } else {
      channel = nightlyChannel
      logger.debug("Setting current version to nightly version")
      await Kbdgen.setNightlyVersion(bundlePath, "macos")
    }
    payloadPath = await Kbdgen.buildMacOS(bundlePath)
  } else if (keyboardType === KeyboardType.Windows) {
    if (isMatchingTag(SEMVER_TAG_RE)) {
      logger.debug("Using version from kbdgen project")
    } else {
      channel = nightlyChannel
      logger.debug("Setting current version to nightly version")
      await Kbdgen.setNightlyVersion(bundlePath, "windows")
    }
    await PahkatPrefix.bootstrap(["devtools"], "nightly")
    console.log("Installing kbdi")
    await PahkatPrefix.install(["kbdi", "kbdgen"])
    console.log("Installed kbdi")
    const kbdi_path = path.join(
      PahkatPrefix.path,
      "pkg",
      "kbdi",
      "bin",
      "kbdi.exe",
    )
    const kbdi_x64_path = path.join(
      PahkatPrefix.path,
      "pkg",
      "kbdi",
      "bin",
      "kbdi-x64.exe",
    )

    console.log("Building Windows")
    const outputPath = await Kbdgen.buildWindows(bundlePath)
    console.log("Built")
    await Deno.copyFile(kbdi_path, path.resolve(outputPath, "kbdi.exe"))
    await Deno.copyFile(kbdi_x64_path, path.resolve(outputPath, "kbdi-x64.exe"))

    console.log("Creating old-style directory structure for Inno Setup")
    // Create symlinks/copies to match what the old CI expected
    const dirMappings = [
      { from: "x86", to: "i386" },
      { from: "x64", to: "amd64" }, 
      { from: "x86", to: "wow64" }  // x86 files also used for wow64
    ]
    
    for (const mapping of dirMappings) {
      const fromDir = path.join(outputPath, mapping.from)
      const toDir = path.join(outputPath, mapping.to)
      try {
        // Check if source directory exists
        const stat = await Deno.stat(fromDir)
        if (stat.isDirectory) {
          console.log(`Copying ${fromDir} to ${toDir}`)
          await Deno.mkdir(toDir, { recursive: true })
          // Copy all files from source to destination
          for await (const entry of Deno.readDir(fromDir)) {
            if (entry.isFile) {
              await Deno.copyFile(
                path.join(fromDir, entry.name), 
                path.join(toDir, entry.name)
              )
            }
          }
        }
      } catch (e) {
        console.log(`Warning: Could not process ${mapping.from} -> ${mapping.to}: ${e.message}`)
      }
    }
    
    console.log("Generating Inno")
    const issPath = await generateKbdInnoFromBundle(bundlePath, outputPath)
    console.log("Inno generated")
    payloadPath = await makeInstaller(issPath)
    console.log("Installer made")
  } else {
    throw new Error(`Unhandled keyboard type: ${keyboardType}`)
  }

  return {
    payloadPath,
    channel,
  }
}

// async function run() {
//   const keyboardType = (await builder.getInput("keyboard-type", {
//     required: true,
//   })) as KeyboardType
//   const nightlyChannel = await builder.getInput("nightly-channel", {
//     required: true,
//   })
//   const override = await builder.getInput("bundle-path")
//   const bundlePath = await getBundle(override)

//   const output = await keyboardBuild({
//     keyboardType,
//     nightlyChannel,
//     bundlePath,
//   })

//   if (output.channel != null) {
//     await builder.setOutput("channel", output.channel)
//   }
//   await builder.setOutput("payload-path", output.payloadPath)
// }
