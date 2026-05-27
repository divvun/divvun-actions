import * as path from "@std/path"
import logger from "~/util/log.ts"
import { makeTempDirSync } from "./temp.ts"

export async function download(url: string, options: {
  fileName?: string
  path?: string
} = {}): Promise<string> {
  const p = options.path ?? makeTempDirSync().path
  const filename = options.fileName ?? path.basename(url)

  logger.info("Downloading", url, "to", p, "as", filename)

  const downloadPath = path.resolve(
    p,
    filename,
  )

  if (Deno.build.os === "windows") {
    logger.info("Downloading", url, "to", downloadPath)
    const proc = new Deno.Command("pwsh", {
      args: [
        // "-NoNewWindow",
        "-Command",
        `Invoke-WebRequest -Uri "${url}" -OutFile "${downloadPath}"`,
      ],
    })
    logger.info("Waiting for process to finish")
    const status = await proc.spawn().status

    logger.info("Process finished with status", status.code)
    if (status.code !== 0) {
      throw new Error(`Process exited with code ${status.code}`)
    }
  } else {
    // --fail turns HTTP >=400 into a non-zero exit; otherwise curl will
    // happily write the error page (e.g. GitHub's "Not Found" stub) to the
    // output file and the caller can't tell anything went wrong.
    const proc = new Deno.Command("curl", {
      args: ["--fail", "-L", "-o", downloadPath, url],
    })
    const status = await proc.spawn().status

    if (status.code !== 0) {
      throw new Error(
        `curl failed (exit ${status.code}) downloading ${url}`,
      )
    }
  }

  logger.info("Downloaded", url, "to", downloadPath)
  return path.resolve(downloadPath)
}
