import * as path from "@std/path"
import * as target from "~/target.ts"

export async function makeInstaller(
  issPath: string,
  defines: string[] = [],
): Promise<string> {
  const installerOutput = await Deno.makeTempDir()
  const scriptPath = `${target.projectPath}\\bin\\divvun-actions`

  const proc = new Deno.Command("iscc.exe", {
    args: [
      `/S"signtool=C:\\msys2\\usr\\bin\\bash -ec '\`/usr/bin/cygpath $q${scriptPath}$q\` sign $f'"`,
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
