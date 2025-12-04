import * as builder from "~/builder.ts"
import { necessaryCodeSign } from "../util/necessary-codesigner.ts"

export default async function sign(inputFile: string) {
  const secrets = await builder.secrets()
  await necessaryCodeSign(inputFile, secrets.get("necessary/codesign"))
}
