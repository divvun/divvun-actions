import * as path from "@std/path"
import * as target from "~/target.ts"
import { makeTempDir } from "../../util/temp.ts"
import logger from "../../util/log.ts"

export async function makeInstaller(
  issPath: string,
): Promise<string> {
  const installerOutput = await makeTempDir()
  const scriptPath = `${target.projectPath}\\bin\\divvun-actions.bat`

  const proc = new Deno.Command(
    "cmd",
    {
      args: [
        "/C",
        path.join(import.meta.dirname ?? "", "build.cmd"),
        scriptPath,
        installerOutput.path,
        issPath,
      ],
    },
  ).spawn()

  const code = (await proc.status).code
  if (code !== 0) {
    logger.debug("=== Inno setup file ===")
    logger.debug(await Deno.readTextFile(issPath))
    logger.debug("=/= === =/=")
    throw new Error(`Process exited with code ${code}`)
  }

  return path.join(installerOutput.path, "install.exe")
}
