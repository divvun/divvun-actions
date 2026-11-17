import { encodeBase64 } from "@std/encoding/base64"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { download } from "~/util/download.ts"
import logger from "~/util/log.ts"
import { makeTempFile } from "~/util/temp.ts"
import { Bash, randomHexBytes } from "./shared.ts"

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

function keychainsDir(): string {
  return path.join(Deno.env.get("HOME")!, "Library", "Keychains")
}

/** Runs `security`, whose arguments can hold a password, so only its subcommand is named in an error. */
async function security(args: string[]): Promise<string> {
  const result = await builder.output("security", args)
  if (!result.status.success) {
    throw new Error(
      `security ${
        args[0]
      } failed (exit ${result.status.code}): ${result.stderr.trim()}`,
    )
  }
  return result.stdout
}

/** The paths `security list-keychains` prints, one quoted path to a line. */
export function parseKeychainSearchList(stdout: string): string[] {
  return stdout.split("\n")
    .map((line) => line.trim().match(/^"(.*)"$/)?.[1])
    .filter((keychainPath): keychainPath is string => keychainPath != null)
}

/**
 * `security` replaces the user's keychain search list as a whole, so two agents
 * on one machine changing it at once can each drop the other's keychain. Every
 * change is made holding this lock, which the kernel releases if the job dies.
 */
async function withSearchListLock<T>(body: () => Promise<T>): Promise<T> {
  using lock = await Deno.open(
    path.join(keychainsDir(), ".divvun-ci-search-list.lock"),
    { create: true, write: true },
  )
  await lock.lock(true)
  try {
    return await body()
  } finally {
    await lock.unlock()
  }
}

/**
 * Puts a keychain first in the search list, where xcodebuild and codesign look
 * for a signing identity, ahead of any other keychain holding the same one.
 */
async function prependToSearchList(keychainPath: string): Promise<void> {
  await withSearchListLock(async () => {
    const current = parseKeychainSearchList(
      await security(["list-keychains", "-d", "user"]),
    )
    // A user always has the login keychain here, so nothing means the list was
    // misread, and writing that back would cut every job off from it.
    if (current.length === 0) {
      throw new Error("The keychain search list read as empty; not changing it")
    }
    await security([
      "list-keychains",
      "-d",
      "user",
      "-s",
      keychainPath,
      ...current.filter((other) => other !== keychainPath),
    ])
  })
}

/** Deletes a keychain, which also takes it out of the search list. */
async function removeKeychain(keychainPath: string): Promise<void> {
  await withSearchListLock(() => security(["delete-keychain", keychainPath]))
}

/**
 * The keychain an agent's jobs sign from. An agent runs one job at a time, so
 * naming it after the agent keeps the agents on one machine apart, and lets a
 * job replace the keychain that a killed job on the same agent left behind.
 */
export function jobKeychainName(
  agentName: string | undefined = Deno.env.get("BUILDKITE_AGENT_NAME"),
): string {
  const agent = agentName?.replace(/[^A-Za-z0-9._-]+/g, "-")
  return `divvun-ci-${agent || `pid-${Deno.pid}`}`
}

export type JobKeychain = {
  /** As fastlane's `MATCH_KEYCHAIN_NAME` takes it: the file name less `-db`. */
  name: string
  path: string
  password: string
}

/**
 * Runs `body` with a keychain made for this job, unlocked, first in the search
 * list and deleted afterwards, so signing keys never enter the login keychain.
 *
 * Nothing asks for a password: the job made the keychain and holds the only
 * password to it, which is what lets the importer (fastlane match, given the
 * name and password) allow codesign to use the keys it puts there.
 */
export async function withJobKeychain<T>(
  body: (keychain: JobKeychain) => Promise<T>,
): Promise<T> {
  const name = jobKeychainName()
  const keychainPath = path.join(keychainsDir(), `${name}.keychain-db`)
  const password = randomHexBytes(32)
  await builder.redactSecret(password)

  if (await Security.keychainExists(name)) {
    logger.info(`Replacing the keychain an earlier job left: ${keychainPath}`)
    await removeKeychain(keychainPath)
  }

  await security(["create-keychain", "-p", password, keychainPath])
  try {
    await security(["unlock-keychain", "-p", password, keychainPath])
    // A new keychain locks itself after five idle minutes, and an archive takes
    // longer than that to reach signing. No options means it never does.
    await security(["set-keychain-settings", keychainPath])
    await prependToSearchList(keychainPath)

    return await body({
      name: `${name}.keychain`,
      path: keychainPath,
      password,
    })
  } finally {
    await removeKeychain(keychainPath).catch((error) =>
      logger.warning(`Could not delete ${keychainPath}:`, error)
    )
  }
}

export interface SetupSigningFromMatchOptions {
  bundleId: string
  keychainName: string
  keychainPassword: string
  matchGitUrl: string
  matchPassword: string
}

// Match installs profiles to ~/Library/Developer/Xcode/UserData/Provisioning Profiles/<UUID>.mobileprovision
// and never removes old ones, so on a persistent build agent this directory
// accumulates profiles from every past cert renewal.
async function findMatchingProfiles(
  profilesDir: string,
  bundleId: string,
): Promise<string[]> {
  const matches: string[] = []
  for await (const entry of Deno.readDir(profilesDir)) {
    if (!entry.name.endsWith(".mobileprovision")) continue

    const fullPath = path.join(profilesDir, entry.name)
    const data = await Deno.readFile(fullPath)
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
    if (text.includes(bundleId)) {
      matches.push(fullPath)
    }
  }
  return matches
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

    const profilesDir = path.join(
      Deno.env.get("HOME")!,
      "Library/Developer/Xcode/UserData/Provisioning Profiles",
    )

    // On a persistent build agent this directory can hold profiles from past
    // cert renewals. Clear out anything for this bundle ID before running
    // match, so the profile we pick up afterwards can't be a stale leftover.
    try {
      const stale = await findMatchingProfiles(profilesDir, bundleId)
      for (const staleProfile of stale) {
        await Deno.remove(staleProfile)
        logger.info(`Removed stale provisioning profile: ${staleProfile}`)
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) {
        throw err
      }
    }

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

    // Read the provisioning profile installed by match. The pre-match
    // cleanup above guarantees at most one profile for this bundle ID can
    // exist here now.
    const matches = await findMatchingProfiles(profilesDir, bundleId)

    if (matches.length === 0) {
      throw new Error(
        `No provisioning profile for ${bundleId} found in ${profilesDir}`,
      )
    }
    if (matches.length > 1) {
      throw new Error(
        `Expected exactly one provisioning profile for ${bundleId} after cleanup, found ${matches.length}: ${
          matches.join(", ")
        }`,
      )
    }

    const profilePath = matches[0]
    logger.info(`Found provisioning profile: ${profilePath}`)
    const profileData = await Deno.readFile(profilePath)
    const mobileProvision = encodeBase64(profileData)

    return { certificate, mobileProvision }
  } finally {
    await Security.deleteKeychain(keychainName).catch(() => {})
  }
}
