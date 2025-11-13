import * as path from "@std/path"
import * as toml from "@std/toml"

import {
  type InstallerResult,
  makeInstaller,
} from "~/actions/inno-setup/lib.ts"
import * as builder from "~/builder.ts"
import { InnoSetupBuilder } from "~/util/inno.ts"
import {
  SpellerPaths,
  Tar,
  ThfstTools,
  versionAsNightly,
} from "~/util/shared.ts"
import { createInstaller } from "./bundle-macos.ts"
import {
  deriveLangTag,
  derivePackageId,
  SpellerManifest,
  SpellerType,
} from "./manifest.ts"

export type Props = {
  spellerType: SpellerType
  manifest: SpellerManifest
  spellerPaths: SpellerPaths
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
}: Props): Promise<Output> {
  const { spellername } = manifest
  const packageId = derivePackageId(spellerType)
  const langTag = deriveLangTag()

  let payloadPath: string

  // TODO: allow release builds
  const isSpellerReleaseTag = RELEASE_TAG.test(builder.env.tag ?? "")
  const version = isSpellerReleaseTag
    ? manifest.package.speller.version
    : await versionAsNightly(manifest.package.speller.version)
  console.log /*logger.debug*/(
    `Speller bundle for ${spellerType} with version ${version} and langTag ${langTag}`,
  )

  if (spellerType == SpellerType.Mobile) {
    const bhfstPaths = []

    for (const [langTag, zhfstPath] of Object.entries(spellerPaths.mobile)) {
      const bhfstPath = await ThfstTools.zhfstToBhfst(zhfstPath)
      const langTagBhfst = `${path.dirname(bhfstPath)}/${langTag}.bhfst`

      console.log /*logger.debug*/(`Copying ${bhfstPath} to ${langTagBhfst}`)
      await Deno.copyFile(bhfstPath, langTagBhfst)
      bhfstPaths.push(langTagBhfst)
    }

    const pktPath = `${packageId}_${version}_noarch-mobile.pkt.tar.zst`
    console.log /*logger.debug*/(
      `Creating pkt from [${bhfstPaths.join(", ")}] at ${pktPath}`,
    )
    payloadPath = pktPath
    await Tar.createFlatPkt(bhfstPaths, payloadPath)
    console.log /*logger.debug*/(`Created pkt at ${payloadPath}`)
  } else if (spellerType == SpellerType.Windows) {
    console.log(manifest.windows)
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
    console.log(zhfstPaths)
    const innoBuilder = new InnoSetupBuilder(Deno.cwd())
      .name(`${spellername} Speller`)
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

        console.log /*logger.debug*/("Writing speller.toml:")
        console.log /*logger.debug*/(toml.stringify(spellerToml))
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
      console.log /*logger.debug*/("Installer created")
    } catch (error) {
      console.warn(
        `Signing failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      console.warn("Retrying without code signing...")
      innoBuilder.write("./install.iss", { codesign: false })
      result = await makeInstaller(".\\install.iss", { skipSigning: true })
      console.log /*logger.debug*/("Unsigned installer created")
    }

    const unsignedSuffix = result.unsigned ? ".UNSIGNED" : ""
    payloadPath = await renameFile(
      result.path,
      `${packageId}_${version}_noarch-windows${unsignedSuffix}.exe`,
    )
    console.log /*logger.debug*/(`Installer created at ${payloadPath}`)
  } else if (spellerType == SpellerType.MacOS) {
    const zhfstFile = spellerPaths.desktop[langTag]
    console.log /*logger.debug*/(
      "Getting desktop zhfst file",
      zhfstFile,
      "for",
      langTag,
    )
    console.log /*logger.debug*/("Speller paths", spellerPaths)

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
    console.log /*logger.debug*/(`Installer created at ${payloadPath}`)
  } else {
    throw new Error(`Unsupported speller type: ${spellerType}`)
  }

  await builder.uploadArtifacts(payloadPath)
  await builder.setMetadata("speller-version", version)
  await builder.setMetadata("speller-type", spellerType)

  return {
    payloadPath,
  }
}

// async function run() {
//   const version = await builder.getInput("version", { required: true })
//   const spellerType = (await builder.getInput("speller-type", {
//     required: true,
//   })) as SpellerType
//   const manifest = toml.parse(
//     await Deno.readFile(
//       await builder.getInput("speller-manifest-path", { required: true }),
//       "utf8",
//     ),
//   ) as SpellerManifest
//   const spellerPaths = nonUndefinedProxy(
//     JSON.parse(await builder.getInput("speller-paths", { required: true })),
//     true,
//   ) as SpellerPaths

//   const { payloadPath } = await spellerBundle({
//     version,
//     spellerType,
//     manifest,
//     spellerPaths,
//   })
//   await builder.setOutput("payload-path", payloadPath)
// }
