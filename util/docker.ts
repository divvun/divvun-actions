import { which } from "@david/which"
import * as fs from "@std/fs"
import * as path from "@std/path"
import { exec } from "~/builder.ts"
import logger from "~/util/log.ts"
import { Powershell } from "./shared.ts"

export default class Docker {
  static readonly DIVVUN_ACTIONS_PATH = path.resolve(
    import.meta.dirname + "/..",
  )

  static async isInContainer() {
    if (Deno.build.os === "windows") {
      return await fs.exists("C:\\actions") && await fs.exists("C:\\workspace")
    }
    return await fs.exists("/actions") && await fs.exists("/workspace")
  }

  static async enterEnvironment(image: string, workingDir: string) {
    if (Deno.build.os === "windows") {
      const dockerPath = await which("docker.exe")

      if (dockerPath == null) {
        throw new Error("Docker not found")
      }

      await exec(
        dockerPath,
        [
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
          "-NoNewWindow",
          "-Command",
          `C:\\actions\\bin\\divvun-actions.ps1`,
          ...Deno.args,
        ],
      )
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
    const tmpDir = Deno.makeTempDirSync()
    const imagePath = path.join(tmpDir, volName)

    await Deno.mkdir(imagePath)

    logger.info("Copying workspace...")
    if (Deno.build.os === "windows") {
      await Powershell.runScript(
        `Copy-Item -Path C:\\workspace\\* -Destination ${imagePath} -Recurse -Force`,
      )
    } else {
      await exec("rsync", ["-ar", "/workspace/", imagePath])
    }

    logger.info(`Entering virtual workspace (${imagePath})...`)
    Deno.chdir(imagePath)

    return imagePath
  }

  static async exitWorkspace(imagePath: string) {
    logger.info(`Exiting virtual workspace (${imagePath})...`)
    Deno.chdir(Deno.env.get("HOME")!)

    logger.info("Removing workspace...")
    await Deno.remove(imagePath, { recursive: true })
  }
}
