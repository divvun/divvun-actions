import * as path from "@std/path"
import * as toml from "@std/toml"

import {
  type InstallerResult,
  makeInstaller,
} from "~/actions/inno-setup/lib.ts"
import * as builder from "~/builder.ts"
import { InnoSetupBuilder } from "~/util/inno.ts"
import { uploadPahkatArtifact } from "~/util/pahkat_artifacts.ts"
import { createPktBox } from "~/util/pkt_box.ts"
import {
  Ditto,
  SpellerPaths,
  Tar,
  ThfstTools,
  versionAsNightly,
} from "~/util/shared.ts"
import { SoftFailure } from "~/util/soft_failure.ts"
import { createInstaller } from "./bundle-macos.ts"
import { buildSpellerOutto, type SpellerOuttoProps } from "./bundle-outto.ts"
import logger from "~/util/log.ts"
import {
  deriveLangTag,
  derivePackageId,
  SpellerManifest,
  SpellerType,
} from "./manifest.ts"

/**
 * Selects which installer toolchain to use: "legacy" builds what the old
 * pahkat.uit.no serves, Inno Setup and a .pkg, and "outto" the Pahkat-next
 * installers.
 */
export type InstallerKind = "legacy" | "outto"

/**
 * Resolve the installer toolchain. Callers may pass `installer` directly;
 * otherwise we honour the DIVVUN_INSTALLER env var ("legacy" | "outto").
 * Defaults to "legacy".
 */
export function resolveInstallerKind(explicit?: InstallerKind): InstallerKind {
  if (explicit) return explicit
  const env = Deno.env.get("DIVVUN_INSTALLER")
  if (env === "outto" || env === "legacy") return env
  return "legacy"
}

export type Props = {
  spellerType: SpellerType
  manifest: SpellerManifest
  spellerPaths: SpellerPaths
  /** Installer toolchain. Defaults to env DIVVUN_INSTALLER, else "legacy". */
  installer?: InstallerKind
  /**
   * The version of the speller's release, which its Pahkat-next artifacts
   * carry. The old artifacts keep the version they always had.
   */
  releaseVersion: string
}

export type Output = {
  payloadPath: string
}

async function renameFile(filePath: string, newPath: string) {
  await Deno.rename(filePath, newPath)
  return newPath
}

const RELEASE_TAG = /^speller-(.*?)\/v\d+\.\d+\.\d+(-\S+)?/

export default async function spellerBundle({
  spellerType,
  manifest,
  spellerPaths,
  installer,
  releaseVersion,
}: Props): Promise<Output> {
  const installerKind = resolveInstallerKind(installer)
  const spellerName = manifest.package.speller.name
  const packageId = derivePackageId(spellerType)
  const langTag = deriveLangTag()

  if (installerKind === "outto") {
    return await bundlePahkatInstaller({
      spellerType,
      packageId,
      langTag,
      version: releaseVersion,
      spellerName,
      manifest,
      spellerPaths,
    })
  }

  let payloadPath: string
  const bhfstPaths: string[] = []

  // TODO: allow release builds
  const isSpellerReleaseTag = RELEASE_TAG.test(builder.env.tag ?? "")
  const version = isSpellerReleaseTag
    ? manifest.package.speller.version
    : await versionAsNightly(
      manifest.package.speller.version,
      builder.env.buildNumber,
    )
  logger.debug(
    `Speller bundle for ${spellerType} with version ${version} and langTag ${langTag}`,
  )

  if (spellerType == SpellerType.Mobile) {
    for (const [langTag, zhfstPath] of Object.entries(spellerPaths.mobile)) {
      const bhfstPath = await ThfstTools.zhfstToBhfst(zhfstPath)
      const langTagBhfst = `${path.dirname(bhfstPath)}/${langTag}.bhfst`

      logger.debug(`Copying ${bhfstPath} to ${langTagBhfst}`)
      await Deno.copyFile(bhfstPath, langTagBhfst)
      bhfstPaths.push(langTagBhfst)
    }

    const pktPath = `${packageId}_${version}_noarch-mobile.pkt.tar.zst`
    logger.debug(
      `Creating pkt from [${bhfstPaths.join(", ")}] at ${pktPath}`,
    )
    payloadPath = pktPath
    await Tar.createFlatPkt(bhfstPaths, payloadPath)
    logger.debug(`Created pkt at ${payloadPath}`)
  } else if (spellerType == SpellerType.Windows) {
    logger.info(manifest.windows)
    if (manifest.windows.system_product_code == null) {
      throw new Error("Missing system_product_code")
    }

    // Fix names of zhfst files to match their tag
    const zhfstPaths: string[] = []
    await Deno.mkdir("./zhfst")
    for (const [key, value] of Object.entries(spellerPaths.desktop)) {
      const out = path.resolve(path.join("./zhfst", `${key}.zhfst`))
      await Deno.rename(value, out)
      zhfstPaths.push(out)
    }
    logger.info(zhfstPaths)
    const innoBuilder = new InnoSetupBuilder(Deno.cwd())
      .name(`${spellerName} Speller`)
      .version(version)
      .publisher("Universitetet i Tromsø - Norges arktiske universitet")
      .url("http://divvun.no/")
      .productCode(manifest.windows.system_product_code)
      .defaultDirName(`{commonpf}\\WinDivvun\\Spellers\\${langTag}`)
      .files((files) => {
        const flags = ["ignoreversion", "recursesubdirs", "uninsrestartdelete"]

        for (const zhfstPath of zhfstPaths) {
          files.add(zhfstPath, "{app}", flags)
        }

        files.add("speller.toml", "{app}", flags)

        return files
      })
      .code((code) => {
        if (manifest.windows.legacy_product_codes) {
          for (const productCode of manifest.windows.legacy_product_codes) {
            code.uninstallLegacy(productCode.value, productCode.kind)
          }
        }

        // Generate the speller.toml
        const spellerToml = {
          spellers: {
            [langTag]: `${langTag}.zhfst`,
          },
        }

        if (manifest.windows.extra_locales) {
          for (
            const [tag, zhfstPrefix] of Object.entries(
              manifest.windows.extra_locales,
            )
          ) {
            spellerToml.spellers[tag] = `${zhfstPrefix}.zhfst`
          }
        }

        logger.debug("Writing speller.toml:")
        logger.debug(toml.stringify(spellerToml))
        Deno.writeTextFileSync(
          "./speller.toml",
          toml.stringify(spellerToml),
        )

        code.execPostInstall(
          "{commonpf}\\WinDivvun\\i686\\spelli.exe",
          `refresh`,
          `Could not refresh spellers. Is WinDivvun installed?`,
        )
        code.execPostUninstall(
          "{commonpf}\\WinDivvun\\i686\\spelli.exe",
          `refresh`,
          `Could not refresh spellers. Is WinDivvun installed?`,
        )

        return code
      })

    // console.log /*logger.debug*/("generated install.iss:")
    // console.log /*logger.debug*/(innoBuilder.build())

    let result: InstallerResult
    try {
      innoBuilder.write("./install.iss", { codesign: true })
      result = await makeInstaller(".\\install.iss")
      logger.debug("Installer created")
    } catch (error) {
      logger.warning(
        `Signing failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      logger.warning("Retrying without code signing...")
      innoBuilder.write("./install.iss", { codesign: false })
      result = await makeInstaller(".\\install.iss", { skipSigning: true })
      logger.debug("Unsigned installer created")
    }

    const unsignedSuffix = result.unsigned ? ".UNSIGNED" : ""
    payloadPath = await renameFile(
      result.path,
      `${packageId}_${version}_noarch-windows${unsignedSuffix}.exe`,
    )
    logger.debug(`Installer created at ${payloadPath}`)
  } else if (spellerType == SpellerType.MacOS) {
    const zhfstFile = spellerPaths.desktop[langTag]
    logger.debug(
      "Getting desktop zhfst file",
      zhfstFile,
      "for",
      langTag,
    )
    logger.debug("Speller paths", spellerPaths)

    if (!zhfstFile) {
      throw new Error(`Missing zhfst file for langTag ${langTag}`)
    }

    const pkgPath = await createInstaller({
      packageId,
      bcp47code: langTag,
      version,
      build: parseInt(builder.env.buildNumber ?? "1"),
      zhfstFile,
      outputDir: "./",
      installerCodeSignId:
        "Developer ID Installer: The University of Tromso (2K5J2584NX)",
      appCodeSignId:
        "Developer ID Application: The University of Tromso (2K5J2584NX)",
    })
    payloadPath = await renameFile(
      pkgPath,
      `${packageId}_${version}_noarch-macos.pkg`,
    )
    logger.debug(`Installer created at ${payloadPath}`)
  } else {
    throw new Error(`Unsupported speller type: ${spellerType}`)
  }

  await builder.uploadArtifacts(payloadPath)
  await builder.setMetadata("speller-version", version)
  await builder.setMetadata("speller-type", spellerType)

  if (spellerType == SpellerType.Mobile) {
    await bundlePahkatMobile(packageId, releaseVersion, bhfstPaths)
  }

  return {
    payloadPath,
  }
}

/**
 * The Pahkat-next mobile speller, made from the same .bhfst files as the
 * tarball, which is uploaded by then: if this fails, the step soft fails and
 * the old deploy still gets the tarball. The keyboards read the spellers in
 * place from the kept archive, so they are stored uncompressed.
 */
async function bundlePahkatMobile(
  packageId: string,
  version: string,
  bhfstPaths: string[],
) {
  const box = `${packageId}_${version}_noarch-mobile.pkt.box`
  try {
    await createPktBox(box, {
      pkg: packageId,
      version,
      files: bhfstPaths.map((file) => ({
        path: file,
        at: `share/divvun/spellers/${path.basename(file)}`,
        stored: true,
      })),
    })
    const artifact = await uploadPahkatArtifact(packageId, box)
    logger.info(`Uploaded the Pahkat-next mobile speller as ${artifact}`)
  } catch (e) {
    throw new SoftFailure(`Could not make the Pahkat-next ${box}`, e)
  }
}

/**
 * A Pahkat-next desktop installer, built with outto and uploaded as a
 * Pahkat artifact, which no old deploy step downloads. The macOS .app is a
 * directory, so it goes up ditto-zipped, which keeps its signature.
 */
async function bundlePahkatInstaller(
  props: Omit<SpellerOuttoProps, "buildNumber">,
): Promise<Output> {
  if (
    props.spellerType !== SpellerType.Windows &&
    props.spellerType !== SpellerType.MacOS
  ) {
    throw new Error(`No outto installer for ${props.spellerType}`)
  }
  const result = await buildSpellerOutto({
    ...props,
    buildNumber: parseInt(builder.env.buildNumber ?? "1"),
  })
  let file = result.payloadPath
  if (props.spellerType === SpellerType.MacOS) {
    file = `${result.payloadPath}.zip`
    await Ditto.zipApp(result.payloadPath, file)
  }
  const artifact = await uploadPahkatArtifact(props.packageId, file)
  logger.info(`Uploaded the Pahkat-next installer as ${artifact}`)
  return { payloadPath: artifact }
}
