export async function sslComCodeSign(inputFile: string, secrets: {
  username: string
  password: string
  credentialId: string
  totpSecret: string
}) {
  const proc = new Deno.Command("CodeSignTool.bat", {
    args: [
      "sign",
      `-input_file_path=${inputFile}`,
      `-totp_secret=${secrets.totpSecret}`,
      `-username=${secrets.username}`,
      `-password=${secrets.password}`,
      `-credential_id=${secrets.credentialId}`,
      "-override",
    ],
  }).spawn()

  const result = await proc.status
  if (result.code != 0) {
    throw new Error(`Docker exited with code ${result.code}`)
  }
}
