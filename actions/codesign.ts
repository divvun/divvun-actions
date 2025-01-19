import * as path from "@std/path"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { Bash } from "~/util/shared.ts"

export type Props = {
  filePath: string
  isInstaller?: boolean
  secrets: {
    developerAccount: string
    appPassword: string
    appCodeSignId: string
    installerCodeSignId: string
    teamId: string
  }
}

export type Output = {
  signedPath: string | null
}

// async function run() {
//   const filePath = path.resolve(
//     await builder.getInput("path", { required: true }),
//   )
//   const isInstaller = Boolean(await builder.getInput("isInstaller")) || false
//   const { signedPath } = await codesign({ filePath, isInstaller })

//   if (signedPath != null) {
//     await builder.setOutput("signed-path", signedPath)
//   }
// }

export default async function codesign({
  filePath,
  isInstaller = false,
  secrets,
}: Props): Promise<Output> {
  let signedPath: string | null = null

  if (Deno.build.os == "windows") {
    logger.debug("  Windows platform")
    // Call our internal API to sign the file
    // This overwrites the unsigned file
    builder.exec("curl", [
      "-v",
      "-X",
      "POST",
      "-F",
      `file=@${filePath}`,
      "http://192.168.122.1:5000",
      "-o",
      `${filePath}`,
    ])
    signedPath = filePath
  } else if (Deno.build.os === "darwin") {
    const {
      developerAccount,
      appPassword,
      appCodeSignId,
      installerCodeSignId,
      teamId,
    } = secrets

    // Codesign with hardened runtime and timestamp
    if (!isInstaller) {
      await builder.exec("codesign", [
        "-s",
        appCodeSignId,
        filePath,
        "--timestamp",
        "--options=runtime",
      ])
    } else {
      await builder.exec("productsign", [
        "--timestamp",
        "--sign",
        installerCodeSignId,
        filePath,
        `${filePath}.signed`,
      ])
      await builder.exec(`mv ${filePath}.signed ${filePath}`)
    }

    // Do some notarization
    const zipPath = path.resolve(path.dirname(filePath), "upload.zip")

    // Create zip file the way that Apple demands
    await builder.exec("ditto", ["-c", "-k", "--keepParent", filePath, zipPath])

    // Upload the zip
    const [response, err] = await Bash.runScript(`
xcrun notarytool submit -v \
    --apple-id "${developerAccount}" \
    --password "${appPassword}" \
    --team-id "${teamId}" \
    --output-format json \
    --wait "${zipPath}"`)

    logger.info(response)

    const parsedResponse = JSON.parse(response)

    if (
      parsedResponse["status"] != "Accepted" &&
      parsedResponse["success"] != true
    ) {
      throw new Error(`Got failure status: ${response}.\n ${err}`)
    }

    await Deno.remove(zipPath)
  }

  return { signedPath }
}
