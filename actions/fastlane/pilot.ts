import { exec } from "~/builder.ts"
import { makeTempFile } from "~/util/temp.ts"

export type FastlanePilotUploadApiKey = {
  key_id: string
  issuer_id: string
  key: string
  duration: number
  in_house: boolean
}

export type FastlanePilotUploadOptions = {
  apiKey: FastlanePilotUploadApiKey
  ipaPath: string
}

export async function fastlanePilotUpload(options: FastlanePilotUploadOptions) {
  using apiKeyPath = await makeTempFile({ suffix: "json" })

  await Deno.writeTextFile(apiKeyPath.path, JSON.stringify(options.apiKey))

  await exec("fastlane", [
    "pilot",
    "upload",
    "--api_key_path",
    apiKeyPath.path,
    "--skip_submission",
    "--skip_waiting_for_build_processing",
    "--ipa",
    options.ipaPath,
  ], {
    env: {
      SPACESHIP_SKIP_2FA_UPGRADE: "1",
      LANG: "en_US.UTF-8",
    },
  })
}
