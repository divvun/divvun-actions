import * as path from "@std/path"
import * as target from "~/target.ts"
import { makeTempDir } from "../../util/temp.ts"
import logger from "../../util/log.ts"

export type InstallerResult = {
  path: string
  unsigned: boolean
}

export async function makeInstaller(
  issPath: string,
  options?: { skipSigning?: boolean },
): Promise<InstallerResult> {
  const installerOutput = await makeTempDir()
  const skipSigning = options?.skipSigning ?? false

  let proc: Deno.ChildProcess

  if (skipSigning) {
    // Call iscc.exe directly without signing
    logger.info("Building installer without code signing...")
    proc = new Deno.Command(
      "iscc.exe",
      {
        args: [
          "/Qp",
          `/O${installerOutput.path}`,
          issPath,
        ],
      },
    ).spawn()
  } else {
    // Use build.cmd which includes signing
    const scriptPath = `${target.projectPath}\\bin\\divvun-actions.bat`
    proc = new Deno.Command(
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
  }

  const code = (await proc.status).code
  if (code !== 0) {
    logger.debug("=== Inno setup file ===")
    logger.debug(await Deno.readTextFile(issPath))
    logger.debug("=/= === =/=")
    throw new Error(`Process exited with code ${code}`)
  }

  return {
    path: path.join(installerOutput.path, "install.exe"),
    unsigned: skipSigning,
  }
}
