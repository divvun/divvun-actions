import { which } from "@david/which"
import * as fs from "@std/fs"
import * as path from "@std/path"
import { exec } from "~/builder.ts"
import type { CommandStep } from "~/builder/pipeline.ts"
import { projectPath } from "~/target.ts"
import logger from "~/util/log.ts"
import { exec as processExec } from "~/util/process.ts"
import { Powershell } from "./shared.ts"
import { makeTempDirSync, makeTempFile } from "./temp.ts"

export default class Docker {
  static readonly DIVVUN_ACTIONS_PATH = path.resolve(
    import.meta.dirname + "/..",
  )

  static async isInContainer() {
    if (Deno.build.os === "windows") {
      return (
        (await fs.exists("C:\\actions")) && (await fs.exists("C:\\workspace"))
      )
    }
    return (await fs.exists("/actions")) && (await fs.exists("/workspace"))
  }

  static async run(image: string, command: string[]) {
    await processExec("docker", ["pull", image])

    const cwd = Deno.cwd()

    // Collect BUILDKITE-prefixed environment variables
    const envVars = Object.entries(Deno.env.toObject())
      .filter(([key]) => key.startsWith("BUILDKITE"))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")

    // Create temp file for env vars
    using envFile = await makeTempFile()
    await Deno.writeTextFile(envFile.path, envVars)

    const args = [
      "run",
      "--rm",
      "-it",
      "-v",
      `${cwd}:/workspace`,
      "-v",
      `${projectPath}:/actions:ro`,
      "--env-file",
      envFile.path,
      image,
      ...command,
    ]

    await processExec("docker", args)
  }

  static async runAlpine(command: string[]) {
    await Docker.run(
      "ghcr.io/divvun/divvun-actions:worker-alpine-latest",
      command,
    )
  }

  static async exec(
    command: CommandStep,
    config: {
      workingDir?: string
      artifactsDir?: string
      image?: string
      platform?: string
      host?: string
    },
  ) {
    const {
      workingDir,
      artifactsDir,
      image = "divvun-actions",
      platform = "linux",
      host = "default",
    } = config
    const args = [
      "-H",
      host,
      "run",
      "--rm",
      "-it",
      // "--mount",
      // `type=bind,source=${workingDir},target=C:\\workspace,readonly`,
      "-v",
      platform === "windows"
        ? `${workingDir}:C:\\\\workspace:ro`
        : `${workingDir}:/workspace:ro`,
      // "-v",
      // platform === "windows"
      //   ? `${Docker.DIVVUN_ACTIONS_PATH}:C:\\actions`
      //   : `${Docker.DIVVUN_ACTIONS_PATH}:/actions:ro`,
    ]

    if (artifactsDir != null) {
      args.push(
        "-v",
        platform === "windows"
          ? `${artifactsDir}:C:\\artifacts`
          : `${artifactsDir}:/artifacts`,
      )
    }

    const envArgs = [
      "-e",
      "CI=1",
      "-e",
      `_DIVVUN_ACTIONS_PLATFORM=${platform}`,
      "-e",
      "_DIVVUN_ACTIONS_ENV=docker",
      "-e",
      "_DIVVUN_ACTIONS_COMMAND=" + JSON.stringify(command),
    ]

    const cmdArgs = platform === "windows"
      ? [
        "pwsh.exe",
        // "-NoNewWindow",
        "-Command",
        `C:\\actions\\bin\\divvun-actions.ps1`,
      ]
      : ["bash", "-lic", `"/actions/bin/divvun-actions"`]

    await exec("docker", [...args, ...envArgs, image + ":latest", ...cmdArgs])
  }

  static async enterEnvironment(image: string, workingDir: string) {
    if (Deno.build.os === "windows") {
      const dockerPath = await which("docker.exe")

      if (dockerPath == null) {
        throw new Error("Docker not found")
      }

      await exec(dockerPath, [
        "run",
        "--rm",
        "-it",
        "-v",
        `${workingDir}:C:\\workspace:ro`,
        "-v",
        `${Docker.DIVVUN_ACTIONS_PATH}:C:\\actions`,
        "-e",
        "CI=1",
        "-e",
        "_DIVVUN_ACTIONS_PLATFORM=windows",
        "-e",
        "_DIVVUN_ACTIONS_ENV=docker",
        image + ":latest",
        "pwsh.exe",
        // "-NoNewWindow",
        "-Command",
        `C:\\actions\\bin\\divvun-actions.ps1`,
        ...Deno.args,
      ])
      return
    }

    await exec("docker", [
      "run",
      "--rm",
      "-it",
      "-v",
      `${workingDir}:/workspace:ro`,
      "-v",
      `${Docker.DIVVUN_ACTIONS_PATH}:/actions:ro`,
      "-e",
      "CI=1",
      "-e",
      "_DIVVUN_ACTIONS_PLATFORM=linux",
      "-e",
      "_DIVVUN_ACTIONS_ENV=docker",
      image + ":latest",
      "bash",
      "-lic",
      `"/actions/bin/divvun-actions" ${Deno.args.join(" ")}`,
    ])
  }

  static async enterWorkspace() {
    const id = crypto.randomUUID()
    const volName = `workspace-${id}`
    const tmpDir = makeTempDirSync()
    const imagePath = path.join(tmpDir.path, volName)

    await Deno.mkdir(imagePath)

    logger.debug("Copying workspace...")
    if (Deno.build.os === "windows") {
      await Powershell.runScript(
        `Copy-Item -Path C:\\workspace\\* -Destination ${imagePath} -Recurse -Force`,
      )
    } else {
      await exec("rsync", ["-ar", "/workspace/", imagePath])
    }

    logger.debug(`Entering virtual workspace (${imagePath})...`)
    Deno.chdir(imagePath)

    return imagePath
  }

  static async exitWorkspace(imagePath: string) {
    logger.debug(`Exiting virtual workspace (${imagePath})...`)
    Deno.chdir(Deno.env.get("HOME")!)

    logger.debug("Removing workspace...")
    await Deno.remove(imagePath, { recursive: true })
  }
}
