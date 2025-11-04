import * as builder from "~/builder.ts"
import { sslComCodeSign } from "../util/sslcom-codesigner.ts"

export default async function sign(inputFile: string) {
  // Try environment variables first (for when called as subprocess from Inno Setup)
  // Fall back to fetching from builder.secrets() if not available
  let username = Deno.env.get("SSLCOM_USERNAME")
  let password = Deno.env.get("SSLCOM_PASSWORD")
  let credentialId = Deno.env.get("SSLCOM_CREDENTIAL_ID")
  let totpSecret = Deno.env.get("SSLCOM_TOTP_SECRET")

  if (!username || !password || !credentialId || !totpSecret) {
    const secrets = await builder.secrets()
    username = secrets.get("sslcom/username")
    password = secrets.get("sslcom/password")
    credentialId = secrets.get("sslcom/credentialId")
    totpSecret = secrets.get("sslcom/totpSecret")
  }

  await sslComCodeSign(inputFile, {
    username,
    password,
    credentialId,
    totpSecret,
  })
}
