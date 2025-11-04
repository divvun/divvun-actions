import * as builder from "~/builder.ts"
import { sslComCodeSign } from "../util/sslcom-codesigner.ts"

export default async function sign(inputFile: string) {
  console.log("=== SIGN COMMAND CALLED ===")
  console.log("Input file:", inputFile)
  console.log("Working directory:", Deno.cwd())

  let username: string
  let password: string
  let credentialId: string
  let totpSecret: string

  // Try reading from secrets file in current working directory
  // (placed there by makeInstaller before calling Inno Setup)
  const secretsFilePath = ".divvun-sign-secrets.json"

  try {
    console.log("Checking for secrets file:", secretsFilePath)
    const secretsData = JSON.parse(await Deno.readTextFile(secretsFilePath))
    username = secretsData.username
    password = secretsData.password
    credentialId = secretsData.credentialId
    totpSecret = secretsData.totpSecret
    console.log("Secrets loaded from file successfully")
  } catch (error) {
    console.log("Secrets file not found, fetching from builder.secrets()...")
    console.log("Error was:", error)
    const secrets = await builder.secrets()
    username = secrets.get("sslcom/username")
    password = secrets.get("sslcom/password")
    credentialId = secrets.get("sslcom/credentialId")
    totpSecret = secrets.get("sslcom/totpSecret")
    console.log("Secrets fetched successfully")
  }

  try {
    await sslComCodeSign(inputFile, {
      username,
      password,
      credentialId,
      totpSecret,
    })
    console.log("=== SIGNING COMPLETED SUCCESSFULLY ===")
  } catch (error) {
    console.error("=== SIGNING FAILED ===")
    console.error("Error:", error)
    throw error
  }
}
