import { encodeBase64 } from "@std/encoding/base64"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { download } from "~/util/download.ts"
import logger from "~/util/log.ts"
import { makeTempFile } from "~/util/temp.ts"
import { Bash } from "./shared.ts"

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

  public static async keychainExists(name: string): Promise<boolean> {
    // Check the file on disk rather than `security list-keychains`, because
    // list-keychains only shows keychains in the search list.  If a previous
    // run was killed after create-keychain but before list-keychains -s, the
    // file exists but won't appear in the search list.
    const home = Deno.env.get("HOME")
    const path = `${home}/Library/Keychains/${name}.keychain-db`
    try {
      await Deno.stat(path)
      return true
    } catch {
      return false
    }
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

export interface SetupSigningFromMatchOptions {
  bundleId: string
  keychainName: string
  keychainPassword: string
  matchGitUrl: string
  matchPassword: string
}

/**
 * Set up iOS signing credentials via fastlane match.
 * Creates a temporary keychain, imports certs via match, exports the
 * distribution certificate and provisioning profile as base64 strings.
 */
export async function setupSigningFromMatch(
  options: SetupSigningFromMatchOptions,
): Promise<{ certificate: string; mobileProvision: string }> {
  const {
    bundleId,
    keychainName,
    keychainPassword,
    matchGitUrl,
    matchPassword,
  } = options

  // Delete any leftover keychain from a previous failed run.
  if (await Security.keychainExists(keychainName)) {
    await Security.deleteKeychain(keychainName)
  }
  await Security.createKeychain(keychainName, keychainPassword)

  try {
    await Security.unlockKeychain(keychainName, keychainPassword)
    await Security.setKeychainTimeout(keychainName, 3600)

    // Import Apple WWDR intermediate cert so the cert chain is complete
    // (required for security find-identity to recognize the distribution cert)
    const wwdrCertPath = await downloadAppleWWDRCA("G3")
    await Security.import(keychainName, wwdrCertPath)

    // Run fastlane match to install cert into keychain
    await builder.exec("fastlane", [
      "match",
      "appstore",
      "--readonly",
      "--app_identifier",
      bundleId,
    ], {
      env: {
        MATCH_GIT_URL: matchGitUrl,
        MATCH_PASSWORD: matchPassword,
        MATCH_KEYCHAIN_NAME: `${keychainName}.keychain`,
        MATCH_KEYCHAIN_PASSWORD: keychainPassword,
      },
    })

    // Export the distribution certificate from the keychain as .p12
    using certFile = await makeTempFile({ suffix: ".p12" })
    const keychainPath = `${
      Deno.env.get("HOME")
    }/Library/Keychains/${keychainName}.keychain-db`

    const exportResult = await new Deno.Command("security", {
      args: [
        "export",
        "-k",
        keychainPath,
        "-t",
        "identities",
        "-f",
        "pkcs12",
        "-P",
        "",
        "-o",
        certFile.path,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output()

    if (!exportResult.success) {
      const stderr = new TextDecoder().decode(exportResult.stderr)
      throw new Error(`Failed to export certificate: ${stderr}`)
    }

    const certData = await Deno.readFile(certFile.path)
    if (certData.length === 0) {
      throw new Error(
        "Exported certificate is empty — cert may not have been imported properly",
      )
    }
    const certificate = encodeBase64(certData)
    logger.info(`Exported certificate from keychain (${certData.length} bytes)`)

    // Read the provisioning profile installed by match.
    // Match installs profiles to ~/Library/Developer/Xcode/UserData/Provisioning Profiles/<UUID>.mobileprovision
    const profilesDir = path.join(
      Deno.env.get("HOME")!,
      "Library/Developer/Xcode/UserData/Provisioning Profiles",
    )

    let profilePath: string | null = null
    for await (const entry of Deno.readDir(profilesDir)) {
      if (!entry.name.endsWith(".mobileprovision")) continue

      const fullPath = path.join(profilesDir, entry.name)
      const data = await Deno.readFile(fullPath)
      const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
      if (text.includes(bundleId)) {
        profilePath = fullPath
        break
      }
    }

    if (!profilePath) {
      throw new Error(
        `No provisioning profile for ${bundleId} found in ${profilesDir}`,
      )
    }

    logger.info(`Found provisioning profile: ${profilePath}`)
    const profileData = await Deno.readFile(profilePath)
    const mobileProvision = encodeBase64(profileData)

    return { certificate, mobileProvision }
  } finally {
    await Security.deleteKeychain(keychainName).catch(() => {})
  }
}
