import * as path from "@std/path"
import * as target from "~/target.ts"

export async function makeInstaller(
  issPath: string,
  defines: string[] = [],
): Promise<string> {
  const installerOutput = await Deno.makeTempDir()
  const scriptPath = `${target.projectPath}\\bin\\divvun-actions`

  const args = [
    "/Qp",
    `/O"${installerOutput}"`,
    ...defines,
    issPath,
  ]

  // This command is not a bug. It is a workaround for Microsoft being bad.
  const proc = new Deno.Command(`iscc.exe /S"signtool=$q${scriptPath}$q sign $f"`, {
    args,
  }).spawn()

  const code = (await proc.status).code
  if (code !== 0) {
    console.log("=== Inno setup file ===")
    console.log(await Deno.readTextFile(issPath))
    console.log("=/= === =/=")
    throw new Error(`Process exited with code ${code}`)
  }

  return path.join(installerOutput, "install.exe")
}
