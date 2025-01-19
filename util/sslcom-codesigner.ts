import * as path from "@std/path"

export async function sign(inputFile: string, secrets: {
  username: string
  password: string
  credentialId: string
  totpSecret: string
}) {
  const inputFolder = path.dirname(inputFile)
  const inputFileName = path.basename(inputFile)

  const proc = new Deno.Command("docker", {
    args: [
      "run",
      "--rm",
      "-e",
      `USERNAME=${secrets.username}`,
      "-e",
      `PASSWORD=${secrets.password}`,
      "-e",
      `CREDENTIAL_ID=${secrets.credentialId}`,
      "-e",
      `TOTP_SECRET=${secrets.totpSecret}`,
      "-v",
      `${inputFolder}:/workspace`,
      "ghcr.io/sslcom/codesigner:latest",
      "sign",
      `-input_file_path=/workspace/${inputFileName}`,
      `-output_dir_path=/workspace/${inputFileName}.signed`,
    ],
  })

  const result = await proc.output()
  if (result.code != 0) {
    throw new Error(`Docker exited with code ${result.code}`)
  }

  await Deno.remove(inputFile)
  await Deno.rename(inputFile + ".signed", inputFile)
}
