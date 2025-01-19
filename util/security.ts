import { decodeBase64 } from "@std/encoding/base64"
import * as builder from "~/builder.ts"
import { download } from "~/util/download.ts"
import logger from "~/util/log.ts"
import { Bash, randomString64 } from "./shared.ts"

export async function downloadAppleWWDRCA(version?: string) {
  if (version == undefined) {
    return await download(
      "https://developer.apple.com/certificationauthority/AppleWWDRCA.cer",
    )
  } else {
    return await download(
      `https://www.apple.com/certificateauthority/AppleWWDRCA${version}.cer`,
    )
  }
}

export async function downloadAppleRootCA(version?: string) {
  if (version == undefined) {
    return await download(
      "https://www.apple.com/appleca/AppleIncRootCertificate.cer",
    )
  } else {
    return await download(
      `https://www.apple.com/certificateauthority/AppleRootCA-${version}.cer`,
    )
  }
}

export async function downloadAppleDevIdCA(version?: string) {
  if (version == undefined) {
    return await download(
      "https://www.apple.com/certificateauthority/DeveloperIDCA.cer",
    )
  } else {
    return await download(
      `https://www.apple.com/certificateauthority/DeveloperID${version}CA.cer`,
    )
  }
}

export class Security {
  constructor() {
    throw new Error("cannot be instantiated")
  }

  private static async run(subcommand: string, args: string[]) {
    return await Bash.runScript(`security ${subcommand} ${args.join(" ")}`)
  }

  public static async deleteKeychain(name: string) {
    return await Security.run("delete-keychain", [`${name}.keychain`])
  }

  public static async createKeychain(name: string, password: string) {
    builder.redactSecret(password)
    return await Security.run("create-keychain", [
      "-p",
      `"${password}"`,
      `${name}.keychain`,
    ])
  }

  public static async defaultKeychain(name: string) {
    await Security.run("list-keychains", [
      "-s",
      "/Users/admin/Library/Keychains/login.keychain-db",
      `${name}.keychain`,
    ])
    return await Security.run("default-keychain", ["-s", `${name}.keychain`])
  }

  public static async unlockKeychain(name: string, password: string) {
    builder.redactSecret(password)
    return await Security.run("unlock-keychain", [
      "-p",
      `"${password}"`,
      `${name}.keychain`,
    ])
  }

  public static async setKeychainTimeout(name: string, timeout: number) {
    const intTimeout = (timeout | 0).toString()
    return await Security.run("set-keychain-settings", [
      "-t",
      intTimeout,
      "-u",
      `${name}.keychain`,
    ])
  }

  public static async import(
    keychainName: string,
    certOrKeyPath: string,
    keyPassword?: string,
  ) {
    if (keyPassword != null) {
      builder.redactSecret(keyPassword)
      return await Security.run("import", [
        certOrKeyPath,
        "-k",
        `~/Library/Keychains/${keychainName}.keychain`,
        "-P",
        `"${keyPassword}"`,
        "-A",
        "-T",
        "/usr/bin/codesign",
        "-T",
        "/usr/bin/security",
        "-T",
        "/usr/bin/productbuild",
      ])
    } else {
      return await Security.run("import", [
        certOrKeyPath,
        "-k",
        `~/Library/Keychains/${keychainName}.keychain`,
        "-A",
      ])
    }
  }

  public static async setKeyPartitionList(
    keychainName: string,
    password: string,
    partitionList: string[],
  ) {
    builder.redactSecret(password)
    return await Security.run("set-key-partition-list", [
      "-S",
      partitionList.join(","),
      "-s",
      "-k",
      `"${password}"`,
      `${keychainName}.keychain`,
    ])
  }
}

export async function setupMacOSKeychain(secrets: {
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

  // mkdir -p ~/.ssh
  // cp $DIR/id_rs* ~/.ssh
  // ssh-keyscan github.com > ~/.ssh/known_hosts
  // chmod 600 ~/.ssh/*
}

function debug(input: string[]) {
  const [out, err] = input

  if (out.trim() != "") {
    logger.debug(out)
  }

  if (err.trim() != "") {
    logger.error(err)
  }
}
