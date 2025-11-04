import * as builder from "~/builder.ts"
import { sslComCodeSign } from "../util/sslcom-codesigner.ts"

export default async function sign(inputFile: string) {
  console.log("=== SIGN COMMAND CALLED ===")
  console.log("Input file:", inputFile)

  // Try environment variables first (for when called as subprocess from Inno Setup)
  // Fall back to fetching from builder.secrets() if not available
  let username = Deno.env.get("SSLCOM_USERNAME")
  let password = Deno.env.get("SSLCOM_PASSWORD")
  let credentialId = Deno.env.get("SSLCOM_CREDENTIAL_ID")
  let totpSecret = Deno.env.get("SSLCOM_TOTP_SECRET")

  console.log("Env vars present:", {
    username: !!username,
    password: !!password,
    credentialId: !!credentialId,
    totpSecret: !!totpSecret,
  })

  if (!username || !password || !credentialId || !totpSecret) {
    console.log("Fetching secrets from builder.secrets()...")
    const secrets = await builder.secrets()
    username = secrets.get("sslcom/username")
    password = secrets.get("sslcom/password")
    credentialId = secrets.get("sslcom/credentialId")
    totpSecret = secrets.get("sslcom/totpSecret")
    console.log("Secrets fetched successfully")
  } else {
    console.log("Using secrets from environment variables")
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
