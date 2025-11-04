import * as builder from "~/builder.ts"
import { sslComCodeSign } from "../util/sslcom-codesigner.ts"

function log(message: string) {
  const logFile = ".divvun-sign-debug.log"
  const timestamp = new Date().toISOString()
  const logMessage = `[${timestamp}] ${message}\n`
  try {
    Deno.writeTextFileSync(logFile, logMessage, { append: true })
  } catch {
    // Ignore log errors
  }
  console.log(message)
}

export default async function sign(inputFile: string) {
  try {
    log("=== SIGN COMMAND CALLED ===")
    log(`Input file: ${inputFile}`)
    log(`Working directory: ${Deno.cwd()}`)

    let username: string
    let password: string
    let credentialId: string
    let totpSecret: string

    // Try reading from secrets file in current working directory
    // (placed there by makeInstaller before calling Inno Setup)
    const secretsFilePath = ".divvun-sign-secrets.json"

    try {
      log(`Checking for secrets file: ${secretsFilePath}`)
      const secretsData = JSON.parse(await Deno.readTextFile(secretsFilePath))
      username = secretsData.username
      password = secretsData.password
      credentialId = secretsData.credentialId
      totpSecret = secretsData.totpSecret
      log("Secrets loaded from file successfully")
    } catch (error) {
      log("Secrets file not found, fetching from builder.secrets()...")
      log(`Error was: ${error}`)
      const secrets = await builder.secrets()
      username = secrets.get("sslcom/username")
      password = secrets.get("sslcom/password")
      credentialId = secrets.get("sslcom/credentialId")
      totpSecret = secrets.get("sslcom/totpSecret")
      log("Secrets fetched successfully")
    }

    try {
      log("Calling sslComCodeSign...")
      await sslComCodeSign(inputFile, {
        username,
        password,
        credentialId,
        totpSecret,
      })
      log("=== SIGNING COMPLETED SUCCESSFULLY ===")
    } catch (error) {
      log("=== SIGNING FAILED ===")
      log(`Error: ${error}`)
      throw error
    }
  } catch (error) {
    log(`=== UNHANDLED ERROR IN SIGN COMMAND ===`)
    log(`Error: ${error}`)
    throw error
  }
}
