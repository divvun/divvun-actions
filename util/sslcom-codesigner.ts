import * as path from "@std/path"

export async function sslComCodeSign(inputFile: string, secrets: {
  username: string
  password: string
  credentialId: string
  totpSecret: string
}) {
  const absFilePath = await Deno.realPath(inputFile)
  let signedPath = inputFile

  const hasInvalidExt = !inputFile.endsWith(".exe") && !inputFile.endsWith(".dll")
  
  if (hasInvalidExt) {
    signedPath = `${absFilePath}.exe`
    await Deno.rename(absFilePath, signedPath)
  }

  const dir = path.dirname(inputFile)
  const files = await Deno.readDir(dir)
  console.log('##---##')
  for await (const file of files) {
    console.log(file.name)
  }
  console.log('##---##')

  const proc = new Deno.Command("CodeSignTool.bat", {
    args: [
      "sign",
      `-input_file_path=${signedPath}`,
      `-totp_secret=${secrets.totpSecret}`,
      `-username=${secrets.username}`,
      `-password=${secrets.password}`,
      `-credential_id=${secrets.credentialId}`,
      "-override",
    ],
    // Unbelievably shit code.
    cwd: "C:\\CodeSignTool",
  }).spawn()

  const result = await proc.status
  if (result.code != 0) {
    throw new Error(`CodeSignTool exited with code ${result.code}`)
  }

  if (hasInvalidExt) {
    await Deno.rename(signedPath, absFilePath)
  }
}
