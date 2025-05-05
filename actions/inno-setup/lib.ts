import * as path from "@std/path"

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

  const proc = new Deno.Command(`iscc.exe" /S"signtool=divvun-actions sign $f"`, {
    args: [
      "/Qp",
      `/O${installerOutput}`,
      ...defines,
      issPath,
    ],
  }).spawn()

  const code = (await proc.status).code
  if (code !== 0) {
    throw new Error(`Process exited with code ${code}`)
  }

  return path.join(installerOutput, "install.exe")
}
