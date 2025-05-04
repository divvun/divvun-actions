import * as path from "@std/path"

export async function download(url: string, options: {
  fileName?: string
  path?: string
} = {}): Promise<string> {
  const downloadPath = path.resolve(
    options.path ?? Deno.makeTempDirSync(),
    options.fileName ?? path.basename(url),
  )

  if (Deno.build.os === "windows") {
    console.log("Downloading", url, "to", downloadPath)
    const proc = new Deno.Command("pwsh", {
      args: [
        // "-NoNewWindow",
        "-Command",
        `Invoke-WebRequest -Uri "${url}" -OutFile "${downloadPath}"`,
      ],
    })
    console.log("Waiting for process to finish")
    const status = await proc.spawn().status

    console.log("Process finished with status", status.code)
    if (status.code !== 0) {
      throw new Error(`Process exited with code ${status.code}`)
    }
  } else {
    const proc = new Deno.Command("curl", {
      args: ["-L", "-o", downloadPath, url],
    })
    const status = await proc.spawn().status

    if (status.code !== 0) {
      throw new Error(`Process exited with code ${status.code}`)
    }
  }

  return path.resolve(downloadPath)
}
