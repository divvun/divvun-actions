import { exec } from "~/builder.ts"

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
  const apiKeyPath = await Deno.makeTempFile({ suffix: "json" })
  await Deno.writeTextFile(apiKeyPath, JSON.stringify(options.apiKey))

  await exec("fastlane", [
    "pilot",
    "upload",
    "--api_key_path",
    apiKeyPath,
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
