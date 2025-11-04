import * as path from "@std/path"
import * as target from "~/target.ts"
import * as builder from "~/builder.ts"
import { makeTempDir } from "../../util/temp.ts"
import logger from "../../util/log.ts"

export async function makeInstaller(
  issPath: string,
): Promise<string> {
  const installerOutput = await makeTempDir()
  const scriptPath = `${target.projectPath}\\bin\\divvun-actions.bat`

  // Fetch signing secrets and pass them via environment variables
  // so they're available to the sign subprocess called by Inno Setup
  logger.info("Fetching signing secrets for Inno Setup...")
  const secrets = await builder.secrets()
  const env = {
    ...Deno.env.toObject(),
    SSLCOM_USERNAME: secrets.get("sslcom/username"),
    SSLCOM_PASSWORD: secrets.get("sslcom/password"),
    SSLCOM_CREDENTIAL_ID: secrets.get("sslcom/credentialId"),
    SSLCOM_TOTP_SECRET: secrets.get("sslcom/totpSecret"),
  }
  logger.info("Signing secrets fetched and added to environment")

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
      env,
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
