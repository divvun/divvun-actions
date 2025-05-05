import * as path from "@std/path"
import * as target from "~/target.ts"

export async function makeInstaller(
  issPath: string,
  defines: string[] = [],
): Promise<string> {
  const installerOutput = await Deno.makeTempDir()

  // Use our custom code signing service running on the CI machine
  // const signCmd = `/S"signtool=curl -v ` +
  //   `-F file=@$f ` +
  //   `http://192.168.122.1:5000 ` +
  //   `-o $f"`

  const scriptPath = `${target.projectPath}\\bin\\divvun-actions.ps1`
  console.log(scriptPath)

  const proc = new Deno.Command("iscc.exe", {
    args: [
      `/S"signtool=${scriptPath} sign $f"`,
      "/Qp",
      `/O${installerOutput}`,
      ...defines,
      issPath,
    ],
    windowsRawArguments: true,
  }).spawn()

  const code = (await proc.status).code
  if (code !== 0) {
    throw new Error(`Process exited with code ${code}`)
  }

  return path.join(installerOutput, "install.exe")
}
