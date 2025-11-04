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

  // Fetch signing secrets and write to temp file next to the ISS file
  // Use a predictable path so subprocess doesn't need to read env vars
  logger.info("Fetching signing secrets for Inno Setup...")
  const secrets = await builder.secrets()

  // Write secrets next to the ISS file so the sign subprocess can find it
  const issDir = path.dirname(issPath)
  const secretsFilePath = path.join(issDir, ".divvun-sign-secrets.json")
  const secretsData = {
    username: secrets.get("sslcom/username"),
    password: secrets.get("sslcom/password"),
    credentialId: secrets.get("sslcom/credentialId"),
    totpSecret: secrets.get("sslcom/totpSecret"),
  }
  await Deno.writeTextFile(secretsFilePath, JSON.stringify(secretsData))
  logger.info(`Signing secrets written to: ${secretsFilePath}`)

  const env = {
    ...Deno.env.toObject(),
  }

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
      stdout: "piped",
      stderr: "piped",
    },
  )

  const { code, stdout, stderr } = await proc.output()

  // Always log stdout/stderr to see what happened
  const decoder = new TextDecoder()
  const stdoutStr = decoder.decode(stdout)
  const stderrStr = decoder.decode(stderr)

  if (stdoutStr) {
    console.log("=== Inno Setup stdout ===")
    console.log(stdoutStr)
  }
  if (stderrStr) {
    console.error("=== Inno Setup stderr ===")
    console.error(stderrStr)
  }

  // Clean up secrets file
  try {
    await Deno.remove(secretsFilePath)
    logger.info("Secrets file cleaned up")
  } catch (error) {
    logger.warn(`Failed to clean up secrets file: ${error}`)
  }

  if (code !== 0) {
    logger.debug("=== Inno setup file ===")
    logger.debug(await Deno.readTextFile(issPath))
    logger.debug("=/= === =/=")
    throw new Error(`Process exited with code ${code}`)
  }

  return path.join(installerOutput.path, "install.exe")
}
