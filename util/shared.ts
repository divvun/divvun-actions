// deno-lint-ignore-file require-await no-explicit-any
import { crypto } from "@std/crypto"
import { decodeBase64, encodeBase64 } from "@std/encoding/base64"
import { encodeHex } from "@std/encoding/hex"
import * as fs from "@std/fs"
import * as path from "@std/path"
import * as yaml from "@std/yaml"
import * as builder from "~/builder.ts"
import { download } from "~/util/download.ts"
import logger from "~/util/log.ts"
import { Security } from "./security.ts"

// export const WINDOWS_SIGNING_HASH_ALGORITHM = "sha256"
export const RFC3161_URL = "http://ts.ssl.com"
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(() => resolve(), ms))

export function tmpDir() {
  return Deno.makeTempDirSync()
}

export function randomString64() {
  return encodeBase64(crypto.getRandomValues(new Uint8Array(48)))
}

export function randomHexBytes(count: number) {
  return encodeHex(crypto.getRandomValues(new Uint8Array(count)))
}

// export const DIVVUN_PFX =
//   `${divvunConfigDir()}\\enc\\creds\\windows\\divvun.pfx`

function env() {
  const langs = {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  }

  if (Deno.build.os === "darwin") {
    langs.LANG = "en_US.UTF-8"
    langs.LC_ALL = "en_US.UTF-8"
  }

  return {
    ...Deno.env.toObject(),
    ...langs,
    DEBIAN_FRONTEND: "noninteractive",
    DEBCONF_NONINTERACTIVE_SEEN: "true",
    PYTHONUTF8: "1",
  }
}

function assertExit0(code: number, stderr?: string) {
  if (code !== 0) {
    logger.error(`Process exited with exit code ${code}.`)
    if (stderr) {
      logger.error("Stderr:")
      logger.error(stderr)
    }
    Deno.exit(code)
  }
}

export class Apt {
  static async update(requiresSudo: boolean) {
    if (requiresSudo) {
      assertExit0(
        await builder.exec("sudo", ["apt-get", "-qy", "update"], {
          env: env(),
        }),
      )
    } else {
      assertExit0(
        await builder.exec("apt-get", ["-qy", "update"], { env: env() }),
      )
    }
  }

  static async install(packages: string[], requiresSudo: boolean) {
    if (requiresSudo) {
      assertExit0(
        await builder.exec(
          "sudo",
          ["apt-get", "install", "-qfy", ...packages],
          { env: env() },
        ),
      )
    } else {
      assertExit0(
        await builder.exec("apt-get", ["install", "-qfy", ...packages], {
          env: env(),
        }),
      )
    }
  }
}

export class Pip {
  static async install(packages: string[]) {
    assertExit0(
      await builder.exec("pip3", ["install", "--user", ...packages], {
        env: env(),
      }),
    )
    builder.addPath(path.join(Deno.env.get("HOME")!, ".local", "bin"))
  }
}

export class Pipx {
  static async ensurepath() {
    assertExit0(await builder.exec("pipx", ["ensurepath"], { env: env() }))
  }

  static async install(packages: string[]) {
    assertExit0(
      await builder.exec("pipx", ["install", ...packages], { env: env() }),
    )
  }
}

export class Powershell {
  static async runScript(
    script: string,
    opts: {
      cwd?: string
      env?: { [key: string]: string }
    } = {},
  ) {
    const thisEnv = Object.assign({}, env(), opts.env)

    const out: string[] = []
    const err: string[] = []

    const listeners = {
      stdout: (data: Uint8Array) => {
        out.push(data.toString())
      },
      stderr: (data: Uint8Array) => {
        err.push(data.toString())
      },
    }

    assertExit0(
      await builder.exec("pwsh", ["-c", script], {
        env: thisEnv,
        cwd: opts.cwd,
        listeners,
      }),
    )
    return [out.join(""), err.join("")]
  }
}

export class DefaultShell {
  static async runScript(
    script: string,
    args: {
      sudo?: boolean
      cwd?: string
      env?: { [key: string]: string }
    } = {},
  ) {
    if (Deno.build.os === "windows") {
      return await Powershell.runScript(script, args)
    } else {
      return await Bash.runScript(script, args)
    }
  }
}

export class Bash {
  static async runScript(
    scriptInput: string | string[],
    args: {
      sudo?: boolean
      cwd?: string
      env?: { [key: string]: string }
    } = {},
  ) {
    const script = typeof scriptInput === "string"
      ? scriptInput
      : scriptInput.join(";\n")
    const thisEnv = Object.assign({}, env(), args.env)

    const cmd = args.sudo ? "sudo" : "bash"
    const cmdArgs = args.sudo ? ["bash", "-c", script] : ["-c", script]

    const { stdout, stderr, status } = await builder.output(cmd, cmdArgs, {
      env: thisEnv,
      cwd: args.cwd,
    })

    if (status.code !== 0) {
      logger.error(`Process exited with code ${status.code}`)
      logger.error("Stdout:")
      logger.error(stdout)
      logger.error("Stderr:")
      logger.error(stderr)
      Deno.exit(status.code)
    }

    return [stdout, stderr]
  }
}

export class Tar {
  static async extractTxz(filePath: string, outputDir?: string) {
    // const platform = Deno.build.os

    // if (platform === "linux" || platform === "darwin") {
    const dir = outputDir || tmpDir()
    const proc = new Deno.Command("tar", {
      args: ["xf", filePath],
      cwd: dir,
    }).spawn()

    const code = (await proc.status).code
    if (code !== 0) {
      throw new Error(`Process exited with code ${code}`)
    }

    return dir
    // } else if (platform === "windows") {
    //   // Now we unxz it
    //   logger.debug("Attempt to unxz")
    //   await builder.exec("xz", ["-d", filePath])

    //   logger.debug("Attempted to extract tarball")
    //   return await builder.extractTar(
    //     `${path.dirname(filePath)}\\${path.basename(filePath, ".txz")}.tar`,
    //     outputDir || tmpDir(),
    //   )
    // } else {
    //   throw new Error(`Unsupported platform: ${platform}`)
    // }
  }

  static async createFlatTxz(paths: string[], outputPath: string) {
    const tmpDir = await Deno.makeTempDir()
    const stagingDir = path.join(tmpDir, "staging")
    await Deno.mkdir(stagingDir)

    logger.debug(`Created tmp dir: ${tmpDir}`)

    for (const p of paths) {
      logger.debug(`Copying ${p} into ${stagingDir}`)
      // TODO: check this actually works
      await Bash.runScript(`cp -r ${p} ${stagingDir}`)
    }

    logger.debug(`Tarring`)
    await Bash.runScript(`tar cf ../file.tar *`, { cwd: stagingDir })

    logger.debug("xz -9'ing")
    await Bash.runScript(`xz -9 ../file.tar`, { cwd: stagingDir })

    logger.debug("Copying file.tar.xz to " + outputPath)
    await Deno.copyFile(path.join(tmpDir, "file.tar.xz"), outputPath)
  }
}

export enum RebootSpec {
  Install = "install",
  Uninstall = "uninstall",
  Update = "update",
}
export enum WindowsExecutableKind {
  Inno = "inno",
  Nsis = "nsis",
  Msi = "msi",
}

let _pahkatPrefixPath: string | null = null

export class PahkatPrefix {
  static URL_LINUX =
    "https://pahkat.uit.no/devtools/download/pahkat-prefix-cli?platform=linux&channel=nightly"
  static URL_MACOS =
    "https://pahkat.uit.no/devtools/download/pahkat-prefix-cli?platform=macos&channel=nightly"
  static URL_WINDOWS =
    "https://pahkat.uit.no/devtools/download/pahkat-prefix-cli?platform=windows&channel=nightly"

  static get path(): string {
    if (_pahkatPrefixPath == null) {
      _pahkatPrefixPath = path.join(tmpDir(), "pahkat-prefix")
    }
    return _pahkatPrefixPath
  }

  static async bootstrap() {
    const platform = Deno.build.os

    let txz
    if (platform === "linux") {
      txz = await download(PahkatPrefix.URL_LINUX)
    } else if (platform === "darwin") {
      txz = await download(PahkatPrefix.URL_MACOS)
    } else if (platform === "windows") {
      // Now we can download things
      txz = await download(
        PahkatPrefix.URL_WINDOWS,
        { fileName: "pahkat-dl.txz" },
      )
    } else {
      throw new Error(`Unsupported platform: ${platform}`)
    }

    // Extract the file
    const outputPath = await Tar.extractTxz(txz)
    const binPath = path.resolve(outputPath, "bin")

    logger.info(`Bin path: ${binPath}, platform: ${Deno.build.os}`)
    builder.addPath(binPath)

    // Init the repo
    if (await fs.exists(PahkatPrefix.path)) {
      logger.debug(`${PahkatPrefix.path} exists; deleting first.`)
      await Deno.remove(PahkatPrefix.path, { recursive: true })
    }

    logger.info(`Initializing pahkat prefix at ${PahkatPrefix.path}`)
    await DefaultShell.runScript(`pahkat-prefix init -c ${PahkatPrefix.path}`)
  }

  static async addRepo(url: string, channel?: string) {
    if (channel != null) {
      await DefaultShell.runScript(
        `pahkat-prefix config repo add -c ${PahkatPrefix.path} ${url} ${channel}`,
      )
    } else {
      await DefaultShell.runScript(
        `pahkat-prefix config repo add -c ${PahkatPrefix.path} ${url}`,
      )
    }
  }

  static async install(packages: string[]) {
    await DefaultShell.runScript(
      `pahkat-prefix install ${packages.join(" ")} -c ${PahkatPrefix.path}`,
    )

    for (const pkg of packages) {
      builder.addPath(
        path.join(PahkatPrefix.path, "pkg", pkg.split("@").shift()!, "bin"),
      )
    }
  }
}

export enum MacOSPackageTarget {
  System = "system",
  User = "user",
}

export type ReleaseRequest = {
  version: string
  platform: string
  arch?: string
  channel?: string
  authors?: string[]
  license?: string
  licenseUrl?: string
  dependencies?: { [key: string]: string }
}

export class PahkatUploader {
  static ARTIFACTS_URL: string = "https://pahkat.uit.no/artifacts/"

  private static async run(args: string[], secrets: {
    apiKey: string
  }): Promise<string> {
    if (Deno.env.get("PAHKAT_NO_DEPLOY") === "true") {
      logger.debug("Skipping deploy because `PAHKAT_NO_DEPLOY` is true")
      return ""
    }

    let output: string = ""

    let exe: string
    if (Deno.build.os === "windows") {
      exe = "pahkat-uploader.exe"
    } else {
      exe = "pahkat-uploader"
    }

    assertExit0(
      await builder.exec(exe, args, {
        env: Object.assign({}, env(), {
          PAHKAT_API_KEY: secrets.apiKey,
        }),
        listeners: {
          stdout: (data: Uint8Array) => {
            output += data.toString()
          },
        },
      }),
    )
    return output
  }

  static async upload(
    artifactPath: string,
    _artifactUrl: string,
    releaseMetadataPath: string,
    repoUrl: string,
    secrets: {
      awsAccessKeyId: string
      awsSecretAccessKey: string
      pahkatApiKey: string
    },
    extra: {
      metadataJsonPath?: string | null
      manifestTomlPath?: string | null
      packageType?: string | null
    } = {},
  ) {
    const fileName = path.parse(artifactPath).base

    if (Deno.env.get("PAHKAT_NO_DEPLOY") === "true") {
      logger.debug(
        "Skipping upload because `PAHKAT_NO_DEPLOY` is true. Creating artifact instead",
      )
      // TODO
      // await builder.createArtifact(fileName, artifactPath)
      return
    }

    if (!await fs.exists(releaseMetadataPath)) {
      throw new Error(
        `Missing required payload manifest at path ${releaseMetadataPath}`,
      )
    }

    logger.info(`Uploading ${artifactPath} to S3`)

    let retries = 0
    await builder.exec("aws", [
      "configure",
      "set",
      "default.s3.multipart_threshold",
      "500MB",
    ])
    while (true) {
      try {
        await builder.exec(
          "aws",
          [
            "s3",
            "cp",
            "--cli-connect-timeout",
            "6000",
            "--endpoint",
            "https://ams3.digitaloceanspaces.com",
            "--acl",
            "public-read",
            artifactPath,
            `s3://divvun/pahkat/artifacts/${fileName}`,
          ],
          {
            env: Object.assign({}, env(), {
              AWS_ACCESS_KEY_ID: secrets.awsAccessKeyId,
              AWS_SECRET_ACCESS_KEY: secrets.awsSecretAccessKey,
              AWS_DEFAULT_REGION: "ams3",
            }),
          },
        )
        logger.info("Upload successful")
        break
      } catch (err) {
        logger.info(err)
        if (retries >= 5) {
          throw err
        }
        await delay(10000)
        logger.info("Retrying")
        retries += 1
      }
    }

    // Step 2: Push the manifest to the server.
    const args = [
      "upload",
      "--url",
      repoUrl,
      "--release-meta",
      releaseMetadataPath,
    ]
    if (extra.metadataJsonPath != null) {
      args.push("--metadata-json")
      args.push(extra.metadataJsonPath)
    }
    if (extra.manifestTomlPath != null) {
      args.push("--manifest-toml")
      args.push(extra.manifestTomlPath)
    }
    if (extra.packageType != null) {
      args.push("--package-type")
      args.push(extra.packageType)
    }
    logger.info(
      await PahkatUploader.run(args, { apiKey: secrets.pahkatApiKey }),
    )
  }

  static releaseArgs(release: ReleaseRequest) {
    const args = ["release"]

    if (release.authors) {
      args.push("--authors")
      for (const item of release.authors) {
        args.push(item)
      }
    }

    if (release.arch) {
      args.push("--arch")
      args.push(release.arch)
    }

    if (release.dependencies) {
      const deps = Object.entries(release.dependencies)
        .map((x) => `${x[0]}::${x[1]}`)
        .join(",")

      args.push("-d")
      args.push(deps)
    }

    if (release.channel) {
      args.push("--channel")
      args.push(release.channel)
    }

    if (release.license) {
      args.push("-l")
      args.push(release.license)
    }

    if (release.licenseUrl) {
      args.push("--license-url")
      args.push(release.licenseUrl)
    }

    args.push("-p")
    args.push(release.platform)

    args.push("--version")
    args.push(release.version)

    return args
  }

  static release = {
    async windowsExecutable(
      release: ReleaseRequest,
      artifactUrl: string,
      installSize: number,
      size: number,
      kind: WindowsExecutableKind | null,
      productCode: string,
      requiresReboot: RebootSpec[],
      secrets: {
        pahkatApiKey: string
      },
    ): Promise<string> {
      const payloadArgs = [
        "windows-executable",
        "-i",
        (installSize | 0).toString(),
        "-s",
        (size | 0).toString(),
        "-p",
        productCode,
        "-u",
        artifactUrl,
      ]

      if (kind != null) {
        payloadArgs.push("-k")
        payloadArgs.push(kind)
      }

      if (requiresReboot.length > 0) {
        payloadArgs.push("-r")
        payloadArgs.push(requiresReboot.join(","))
      }

      const releaseArgs = PahkatUploader.releaseArgs(release)
      return await PahkatUploader.run([...releaseArgs, ...payloadArgs], {
        apiKey: secrets.pahkatApiKey,
      })
    },

    async macosPackage(
      release: ReleaseRequest,
      artifactUrl: string,
      installSize: number,
      size: number,
      pkgId: string,
      requiresReboot: RebootSpec[],
      targets: MacOSPackageTarget[],
      secrets: {
        pahkatApiKey: string
      },
    ): Promise<string> {
      const payloadArgs = [
        "macos-package",
        "-i",
        (installSize | 0).toString(),
        "-s",
        (size | 0).toString(),
        "-p",
        pkgId,
        "-u",
        artifactUrl,
      ]

      if (targets.length > 0) {
        payloadArgs.push("-t")
        payloadArgs.push(targets.join(","))
      }

      if (requiresReboot.length > 0) {
        payloadArgs.push("-r")
        payloadArgs.push(requiresReboot.join(","))
      }

      const releaseArgs = PahkatUploader.releaseArgs(release)
      return await PahkatUploader.run([...releaseArgs, ...payloadArgs], {
        apiKey: secrets.pahkatApiKey,
      })
    },

    async tarballPackage(
      release: ReleaseRequest,
      artifactUrl: string,
      installSize: number,
      size: number,
      secrets: {
        pahkatApiKey: string
      },
    ): Promise<string> {
      const payloadArgs = [
        "tarball-package",
        "-i",
        (installSize | 0).toString(),
        "-s",
        (size | 0).toString(),
        "-u",
        artifactUrl,
      ]

      const releaseArgs = PahkatUploader.releaseArgs(release)
      return await PahkatUploader.run([...releaseArgs, ...payloadArgs], {
        apiKey: secrets.pahkatApiKey,
      })
    },
  }
}

// Since some state remains after the builds, don't grow known_hosts infinitely
const CLEAR_KNOWN_HOSTS_SH = `\
mkdir -pv ~/.ssh
ssh-keyscan github.com | tee -a ~/.ssh/known_hosts
cat ~/.ssh/known_hosts | sort | uniq > ~/.ssh/known_hosts.new
mv ~/.ssh/known_hosts.new ~/.ssh/known_hosts
`

export class Ssh {
  static async cleanKnownHosts() {
    await Bash.runScript(CLEAR_KNOWN_HOSTS_SH)
  }
}

const PROJECTJJ_NIGHTLY_SH = `\
wget -q https://apertium.projectjj.com/apt/install-nightly.sh -O install-nightly.sh && bash install-nightly.sh
`

async function base64AsFile(input: string) {
  const buffer = decodeBase64(input)
  const tmp = await Deno.makeTempFile()
  await Deno.writeFile(tmp, buffer)
  return tmp
}

export class ProjectJJ {
  static async addNightlyToApt(requiresSudo: boolean) {
    await Bash.runScript(PROJECTJJ_NIGHTLY_SH, { sudo: requiresSudo })
  }
}

export class Kbdgen {
  static async fetchMetaBundle(metaBundlePath: string) {
    await Bash.runScript(`kbdgen fetch -b ${metaBundlePath}`)
  }

  private static async resolveOutput(p: string): Promise<string> {
    const files = await fs.expandGlob(p, {
      followSymlinks: false,
    })

    for await (const file of files) {
      logger.debug("Got file for bundle: " + file.path)
      return file.path
    }

    throw new Error("No output found for build.")
  }

  static async loadTarget(bundlePath: string, target: string) {
    return nonUndefinedProxy(
      yaml.parse(
        await Deno.readTextFile(
          path.resolve(bundlePath, "targets", `${target}.yaml`),
        ),
      ),
      true,
    )
  }

  static async loadProjectBundle(bundlePath: string) {
    return nonUndefinedProxy(
      yaml.parse(
        await Deno.readTextFile(path.resolve(bundlePath, "project.yaml")),
      ),
      true,
    )
  }

  static async loadProjectBundleWithoutProxy(bundlePath: string) {
    return yaml.parse(
      await Deno.readTextFile(path.resolve(bundlePath, "project.yaml")),
    )
  }

  static async loadLayouts(bundlePath: string) {
    const files = await fs.expandGlob(
      path.resolve(bundlePath, "layouts/*.yaml"),
    )

    const layouts: { [locale: string]: any } = {}
    for await (const layoutFile of files) {
      const locale = path.parse(layoutFile.path).base.split(".", 1)[0]
      layouts[locale] = yaml.parse(await Deno.readTextFile(layoutFile.path))
    }
    return layouts
  }

  static async setNightlyVersion(bundlePath: string, target: string) {
    const targetData = await Kbdgen.loadTarget(bundlePath, target)

    // Set to minute-based timestamp
    targetData["version"] = await versionAsNightly(targetData["version"])

    await Deno.writeTextFile(
      path.resolve(bundlePath, "targets", `${target}.yaml`),
      yaml.stringify({ ...targetData }),
    )

    return targetData["version"]
  }

  static async setBuildNumber(
    bundlePath: string,
    target: string,
    start: number = 0,
  ) {
    const targetData = await Kbdgen.loadTarget(bundlePath, target)

    // Set to run number
    const versionNumber = parseInt(
      (await Bash.runScript("git rev-list --count HEAD"))[0],
      10,
    )
    targetData["build"] = start + versionNumber
    logger.debug("Set build number to " + targetData["build"])

    await Deno.writeTextFile(
      path.resolve(bundlePath, "targets", `${target}.yaml`),
      yaml.stringify({ ...targetData }),
    )

    return targetData["build"]
  }

  static async build_iOS(bundlePath: string, secrets: {
    githubUsername: string
    githubToken: string
    matchGitUrl: string
    matchPassword: string
    fastlaneUser: string
    fastlanePassword: string
    appStoreKeyJson: string
    appStoreKeyPassword: string
    adminPassword: string
  }): Promise<string> {
    const abs = path.resolve(bundlePath)
    const cwd = path.dirname(abs)

    // await Bash.runScript("brew install imagemagick")
    await Security.unlockKeychain("login", secrets.adminPassword)

    const env = {
      GITHUB_USERNAME: secrets.githubUsername,
      GITHUB_TOKEN: secrets.githubToken,
      MATCH_GIT_URL: secrets.matchGitUrl,
      MATCH_PASSWORD: secrets.matchPassword,
      FASTLANE_USER: secrets.fastlaneUser,
      PRODUCE_USERNAME: secrets.fastlaneUser,
      FASTLANE_PASSWORD: secrets.fastlanePassword,
      APP_STORE_KEY_JSON: await base64AsFile(secrets.appStoreKeyJson),
      MATCH_KEYCHAIN_NAME: "login.keychain",
      MATCH_KEYCHAIN_PASSWORD: secrets.adminPassword,
      LANG: "C.UTF-8",
      RUST_LOG: "kbdgen=debug",
    }

    logger.debug("Gonna import certificates")
    logger.debug("Deleting previous keychain for fastlane")
    try {
      logger.debug("Creating keychain for fastlane")
    } catch (_) {
      // Ignore error here, the keychain probably doesn't exist
    }

    logger.debug("ok, next")

    // Initialise any missing languages first
    // XXX: this no longer works since changes to the API!
    // await Bash.runScript(
    //     `kbdgen --logging debug build ios ${abs} init`,
    //     {
    //         cwd,
    //         env
    //     }
    // )

    // Do the build
    await Bash.runScript(
      `kbdgen target --output-path output --bundle-path ${abs} ios build`,
      {
        cwd,
        env,
      },
    )
    const files = await fs.expandGlob(path.resolve(abs, "../output/ipa/*.ipa"))

    for await (const file of files) {
      return file.path
    }

    throw new Error("No output found for build.")
  }

  static async buildAndroid(
    bundlePath: string,
    // githubRepo: string,
    secrets: {
      githubUsername: string
      githubToken: string
      keyStore: string
      keyAlias: string
      storePassword: string
      keyPassword: string
      playStoreP12: string
      playStoreAccount: string
    },
  ): Promise<string> {
    const abs = path.resolve(bundlePath)
    const cwd = path.dirname(abs)
    // await Bash.runScript("brew install imagemagick")

    logger.debug(`ANDROID_HOME: ${Deno.env.get("ANDROID_HOME")}`)

    await Bash.runScript(
      `kbdgen target --output-path output --bundle-path ${abs} android build`,
      {
        cwd,
        env: {
          GITHUB_USERNAME: secrets.githubUsername,
          GITHUB_TOKEN: secrets.githubToken,
          NDK_HOME: Deno.env.get("ANDROID_NDK_HOME")!,
          ANDROID_KEYSTORE: await base64AsFile(secrets.keyStore),
          ANDROID_KEYALIAS: secrets.keyAlias,
          STORE_PW: secrets.storePassword,
          KEY_PW: secrets.keyPassword,
          PLAY_STORE_P12: await base64AsFile(secrets.playStoreP12),
          PLAY_STORE_ACCOUNT: secrets.playStoreAccount,
          RUST_LOG: "debug",
        },
      },
    )

    return await Kbdgen.resolveOutput(
      path.join(
        cwd,
        "output/repo/app/build/outputs/apk/release",
        `*-release.apk`,
      ),
    )
  }

  static async buildMacOS(bundlePath: string, secrets: {
    passwordChainItem: string
    developerAccount: string
  }): Promise<string> {
    const abs = path.resolve(bundlePath)
    const cwd = path.dirname(abs)

    // Install imagemagick if we're not using the self-hosted runner
    // if (Deno.env.get(""ImageOS"] != null) {")
    //   await Bash.runScript("brew install imagemagick")
    // }

    await Bash.runScript(`kbdgen -V`)
    await Bash.runScript(
      `kbdgen target --output-path output --bundle-path ${abs} macos generate`,
      {
        env: {
          DEVELOPER_PASSWORD_CHAIN_ITEM: secrets.passwordChainItem,
          DEVELOPER_ACCOUNT: secrets.developerAccount,
        },
      },
    )

    await Bash.runScript(
      `kbdgen target --output-path output --bundle-path ${abs} macos build`,
      {
        env: {
          DEVELOPER_PASSWORD_CHAIN_ITEM: secrets.passwordChainItem,
          DEVELOPER_ACCOUNT: secrets.developerAccount,
        },
      },
    )

    return await Kbdgen.resolveOutput(path.join(cwd, "output", `*.pkg`))
  }

  static async buildWindows(bundlePath: string): Promise<string> {
    const abs = path.resolve(bundlePath)
    const cwd = Deno.cwd()

    await Powershell.runScript(
      `kbdgen target --output-path output --bundle-path ${abs} windows`,
    )

    return `${cwd}/output`
  }
}

export class ThfstTools {
  static async zhfstToBhfst(zhfstPath: string): Promise<string> {
    await DefaultShell.runScript(`thfst-tools zhfst-to-bhfst ${zhfstPath}`)
    return `${path.basename(zhfstPath, ".zhfst")}.bhfst`
  }
}

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export async function versionAsNightly(version: string): Promise<string> {
  const verChunks = SEMVER_RE.exec(version)?.slice(1, 4)
  if (verChunks == null) {
    throw new Error(`Provided version '${version}' is not semantic.`)
  }

  // const queueService = new taskcluster.Queue({
  //   rootUrl: Deno.env.get("TASKCLUSTER_PROXY_URL,")
  // })

  // const task = await queueService.task(Deno.env.get("TASK_ID)")

  const nightlyTs = new Date().toISOString().replace(/[-:\.]/g, "")

  return `${verChunks.join(".")}-nightly.${nightlyTs}`
}

function deriveBundlerArgs(
  spellerPaths: SpellerPaths,
  withZhfst: boolean = true,
) {
  const args = []
  for (const [langTag, zhfstPath] of Object.entries(spellerPaths.desktop)) {
    args.push("-l")
    args.push(langTag)

    if (withZhfst) {
      args.push("-z")
      args.push(zhfstPath)
    }
  }
  return args
}

export type SpellerPaths = {
  desktop: { [key: string]: string }
  mobile: { [key: string]: string }
}

export class DivvunBundler {
  static async bundleMacOS(
    name: string,
    version: string,
    packageId: string,
    langTag: string,
    spellerPaths: SpellerPaths,
    secrets: {
      developerAccount: string
      appPassword: string
      installerPassword: string
      teamId: string
    },
  ): Promise<string> {
    const args = [
      "-R",
      "-o",
      "output",
      "-t",
      "osx",
      "-H",
      name,
      "-V",
      version,
      "-a",
      `Developer ID Application: The University of Tromso (2K5J2584NX)`,
      "-i",
      `Developer ID Installer: The University of Tromso (2K5J2584NX)`,
      "-n",
      secrets.developerAccount,
      "-p",
      secrets.appPassword,
      "-d",
      secrets.teamId,
      "speller",
      "-f",
      langTag,
      ...deriveBundlerArgs(spellerPaths),
    ]

    assertExit0(
      await builder.exec("divvun-bundler", args, {
        env: Object.assign({}, env(), {
          RUST_LOG: "trace",
        }),
      }),
    )

    // FIXME: workaround bundler issue creating invalid files
    await Deno.copyFile(
      path.resolve(`output/${langTag}-${version}.pkg`),
      path.resolve(`output/${packageId}-${version}.pkg`),
    )

    const outputFile = path.resolve(`output/${packageId}-${version}.pkg`)
    return outputFile
  }

  // static async bundleWindows(
  //     name: string,
  //     version: string,
  //     manifest: WindowsSpellerManifest,
  //     packageId: string,
  //     langTag: string,
  //     spellerPaths: SpellerPaths
  // ) {
  //     const sec = secrets();

  //     let exe: string
  //     if (Deno.build.os === "windows") {
  //         exe = path.join(PahkatPrefix.path, "pkg", "divvun-bundler", "bin", "divvun-bundler.exe")
  //     } else {
  //         exe = "divvun-bundler"
  //     }

  //     const args = ["-R", "-t", "win", "-o", "output",
  //         "--uuid", productCode,
  //         "-H", name,
  //         "-V", version,
  //         "-c", DIVVUN_PFX,
  //         "speller",
  //         "-f", langTag,
  //         ...deriveBundlerArgs(spellerPaths)
  //     ]

  //     assertExit0(await builder.exec(exe, args, {
  //         env: Object.assign({}, env(), {
  //             "RUST_LOG": "trace",
  //             "SIGN_PFX_PASSWORD": sec.windows.pfxPassword,
  //         })
  //     }))

  //     try {
  //         logger.debug(fs.readdirSync("output").join(", "))
  //     } catch (err) {
  //         logger.debug("Failed to read output dir")
  //         logger.debug(err)
  //     }

  //     // FIXME: workaround bundler issue creating invalid files
  //     await Deno.copyFile(
  //         path.resolve(`output/${langTag}-${version}.exe`),
  //         path.resolve(`output/${packageId}-${version}.exe`))

  //     return path.resolve(`output/${packageId}-${version}.exe`)
  // }
}

export function nonUndefinedProxy(obj: any, withNull: boolean = false): any {
  return new Proxy(obj, {
    get: (target, prop, receiver) => {
      const v = Reflect.get(target, prop, receiver)
      if (v === undefined) {
        throw new Error(
          `'${
            String(
              prop,
            )
          }' was undefined and this is disallowed. Available keys: ${
            Object.keys(
              obj,
            ).join(", ")
          }`,
        )
      }

      if (withNull && v === null) {
        throw new Error(
          `'${
            String(
              prop,
            )
          }' was null and this is disallowed. Available keys: ${
            Object.keys(
              obj,
            ).join(", ")
          }`,
        )
      }

      if (v != null && (Array.isArray(v) || typeof v === "object")) {
        return nonUndefinedProxy(v, withNull)
      } else {
        return v
      }
    },
  })
}

export function validateProductCode(
  kind: WindowsExecutableKind,
  code: string,
): string {
  if (kind === null) {
    logger.debug("Found no kind, returning original code")
    return code
  }

  if (kind === WindowsExecutableKind.Inno) {
    if (code.startsWith("{") && code.endsWith("}_is1")) {
      logger.debug("Found valid product code for Inno installer: " + code)
      return code
    }

    let updatedCode = code

    if (!code.endsWith("}_is1") && !code.startsWith("{")) {
      logger.debug(
        "Found plain UUID for Inno installer, wrapping in {...}_is1",
      )
      updatedCode = `{${code}}_is1`
    } else if (code.endsWith("}") && code.startsWith("{")) {
      logger.debug("Found wrapped GUID for Inno installer, adding _is1")
      updatedCode = `${code}_is1`
    } else {
      throw new Error(`Could not handle invalid Inno product code: ${code}`)
    }

    logger.debug(`'${code}' -> '${updatedCode}`)
    return updatedCode
  }

  if (kind === WindowsExecutableKind.Nsis) {
    if (code.startsWith("{") && code.endsWith("}")) {
      logger.debug("Found valid product code for Nsis installer: " + code)
      return code
    }

    let updatedCode = code

    if (!code.endsWith("}") && !code.startsWith("{")) {
      logger.debug("Found plain UUID for Nsis installer, wrapping in {...}")
      updatedCode = `{${code}}`
    } else {
      throw new Error(`Could not handle invalid Nsis product code: ${code}`)
    }

    logger.debug(`'${code}' -> '${updatedCode}`)
    return updatedCode
  }

  throw new Error("Unhandled kind: " + kind)
}

export function isCurrentBranch(names: string[]) {
  const value = builder.env.branch

  logger.debug(`names: ${names}`)
  logger.debug(`GIT REF: '${value}'`)

  if (value == null) {
    return false
  }

  return names.includes(value)
}

export function isMatchingTag(tagPattern: RegExp) {
  const value = builder.env.tag

  logger.debug(`tag pattern: ${tagPattern}`)
  logger.debug(`GIT REF: '${value}'`)

  if (value == null) {
    return false
  }

  return tagPattern.test(value)
}

export function getArtifactSize(path: string): number {
  try {
    const stats = Deno.statSync(path)
    return stats.size
  } catch (_) {
    return 0
  }
}

const secrets = builder.secrets
export { secrets }
