import * as builder from "~/builder.ts"
import { sslComCodeSign } from "../util/sslcom-codesigner.ts"

export default async function sign(inputFile: string) {
  const secrets = await builder.secrets()

  await sslComCodeSign(inputFile, {
    username: secrets.get("sslcom/username"),
    password: secrets.get("sslcom/password"),
    credentialId: secrets.get("sslcom/credentialId"),
    totpSecret: secrets.get("sslcom/totpSecret"),
  })
}
