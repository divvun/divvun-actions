// deno-lint-ignore-file no-explicit-any
import { decodeBase64 } from "jsr:@std/encoding/base64"
import { downloadAppleDevIdCA, Security } from "~/util/security.ts"

import logger from "~/util/log.ts"
import { Bash, divvunConfigDir, randomString64 } from "~/util/shared.ts"

function debug(input: string[]) {
  const [out, err] = input

  if (out.trim() != "") {
    logger.debug(out)
  }

  if (err.trim() != "") {
    logger.error(err)
  }
}

async function setupMacOSKeychain(secrets: {
  appP12: string
  appP12Password: string
  installerP12: string
  installerP12Password: string
  developerAccount: string
  passwordChainItem: string
  appPassword: string
  developerAccountMacos: string
  passwordChainItemMacos: string
  appPasswordMacos: string
}) {
  const name = `divvun-build`
  const password = randomString64()

  try {
    debug(await Security.deleteKeychain(name))
  } catch (_) {
    // Ignore
  }

  debug(await Security.createKeychain(name, password))
  debug(await Security.defaultKeychain(name))
  debug(await Security.unlockKeychain(name, password))
  debug(await Security.setKeychainTimeout(name, 36000))

  // Import certs
  const certPath5 = await downloadAppleDevIdCA("G2")
  debug(await Security.import(name, certPath5))

  const appP12Path = await Deno.makeTempFile({ suffix: ".p12" })
  const appP12Buff = decodeBase64(secrets.appP12)
  await Deno.writeFile(appP12Path, appP12Buff)
  debug(await Security.import(name, appP12Path, secrets.appP12Password))

  const installerP12Path = await Deno.makeTempFile({ suffix: ".p12" })
  const installerP12Buff = decodeBase64(secrets.installerP12)
  await Deno.writeFile(installerP12Path, installerP12Buff)
  debug(
    await Security.import(
      name,
      installerP12Path,
      secrets.installerP12Password,
    ),
  )

  debug(
    await Security.setKeyPartitionList(name, password, [
      "apple-tool:",
      "apple:",
      "codesign:",
    ]),
  )

  // This is needed in kbdgen for macOS builds.
  debug(
    await Bash.runScript(
      `security add-generic-password -A -s "${secrets.passwordChainItem}" -a "${secrets.developerAccount}" -w "${secrets.appPassword}" "${name}"`,
    ),
  )
  debug(
    await Bash.runScript(
      `security add-generic-password -A -s "${secrets.passwordChainItemMacos}" -a "${secrets.developerAccountMacos}" -w "${secrets.appPasswordMacos}" "${name}"`,
    ),
  )
  debug(
    await Bash.runScript(
      `security set-generic-password-partition-list -S "apple-tool:,apple:,codesign:,security:" -a "${secrets.developerAccount}" -k "${password}" ${name}.keychain`,
    ),
  )
  debug(
    await Bash.runScript(
      `security set-generic-password-partition-list -S "apple-tool:,apple:,codesign:,security:" -a "${secrets.developerAccountMacos}" -k "${password}" ${name}.keychain`,
    ),
  )

  debug(await Bash.runScript(`bash ${divvunConfigDir()}/enc/install.sh`))
}

// async function run() {
//   const divvunKey = await builder.getInput("key", { required: true })
//   await setup({ divvunKey })
// }
