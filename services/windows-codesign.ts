import * as builder from "~/builder.ts"
import { sslComCodeSign } from "../util/sslcom-codesigner.ts"

export default async function sign(inputFile: string) {
  const secrets = await builder.secrets()
  let signedPath = inputFile

  const hasInvalidExt = !inputFile.endsWith(".exe") && !inputFile.endsWith(".dll")
  
  if (hasInvalidExt) {
    signedPath = `${inputFile}.exe`
    await Deno.rename(inputFile, signedPath)
  }

  await sslComCodeSign(inputFile, {
    username: secrets.get("sslcom/username"),
    password: secrets.get("sslcom/password"),
    credentialId: secrets.get("sslcom/credentialId"),
    totpSecret: secrets.get("sslcom/totpSecret"),
  })

  if (hasInvalidExt) {
    await Deno.rename(signedPath, inputFile)
  }
}
