import * as path from "jsr:@std/path"
import * as builder from "~/builder.ts"

const APP_NAME = "MacDivvun"

interface CreateInstallerParams {
  packageId: string
  bcp47code: string
  version: string
  build: number
  zhfstFile: string
  outputDir: string
  installerCodeSignId: string
  appCodeSignId: string
}

export async function createInstaller({
  packageId,
  bcp47code,
  version,
  build,
  zhfstFile,
  outputDir,
  installerCodeSignId,
  appCodeSignId,
}: CreateInstallerParams): Promise<string> {
  const packageName = "no.divvun.MacDivvun"
  const bundleName = `${packageName}.${bcp47code}.bundle`

  await createBundle({
    bundleName,
    packageName,
    bcp47code,
    version,
    build,
    zhfstFile,
    outputDir,
  })

  await signBundle(bundleName, appCodeSignId, outputDir)
  await createInstallerFromBundle(
    packageId,
    APP_NAME,
    path.join(outputDir, bundleName),
    version,
    packageName,
    outputDir,
  )
  await signInstaller(packageId, version, installerCodeSignId, outputDir)

  const resolvedName = path.join(outputDir, `${packageId}-${version}.pkg`)
  return resolvedName
}

interface CreateBundleParams {
  bundleName: string
  packageName: string
  bcp47code: string
  version: string
  build: number
  zhfstFile: string
  outputDir: string
}

async function createBundle({
  bundleName,
  packageName,
  bcp47code,
  version,
  build,
  zhfstFile,
  outputDir,
}: CreateBundleParams): Promise<void> {
  await Deno.mkdir(outputDir, { recursive: true })
  const bundleDir = path.join(outputDir, bundleName)

  try {
    await Deno.remove(bundleDir, { recursive: true })
  } catch (err) {
    // Ignore if directory doesn't exist
  }

  const contentPath = path.join(bundleDir, "Contents")
  const resourcesPath = path.join(contentPath, "Resources")
  await Deno.mkdir(resourcesPath, { recursive: true })
  await Deno.copyFile(zhfstFile, path.join(resourcesPath, "speller.zhfst"))

  const plistContent = makePlist(
    bcp47code,
    version,
    build,
    APP_NAME,
    packageName,
  )
  await Deno.writeTextFile(path.join(contentPath, "Info.plist"), plistContent)
}

function makePlist(
  bcp47code: string,
  version: string,
  build: number,
  appName: string,
  packageName: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleIdentifier</key>
	<string>${packageName}.${bcp47code}</string>
	<key>CFBundleName</key>
	<string>${bcp47code}</string>
	<key>CFBundlePackageType</key>
	<string>BNDL</string>
	<key>CFBundleShortVersionString</key>
	<string>${version}</string>
	<key>CFBundleSupportedPlatforms</key>
	<array>
		<string>MacOSX</string>
	</array>
	<key>CFBundleVersion</key>
	<string>${build}</string>
	<key>NSHumanReadableCopyright</key>
	<string>See license file.</string>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSExecutable</key>
			<string>${appName}</string>
			<key>NSLanguages</key>
			<array>
				<string>${bcp47code}</string>
			</array>
			<key>NSMenuItem</key>
			<dict/>
			<key>NSPortName</key>
			<string>${appName}</string>
			<key>NSSpellChecker</key>
			<string>${appName}</string>
		</dict>
	</array>
</dict>
</plist>`
}

async function createInstallerFromBundle(
  packageId: string,
  appName: string,
  bundleDir: string,
  version: string,
  packageName: string,
  outputDir: string,
): Promise<void> {
  const componentPkgName = await createComponentPackage(
    outputDir,
    bundleDir,
    packageName,
    version,
  )
  const distributionPath = path.join(outputDir, "distribution.xml")

  const distributionContent = makeDistribution(
    appName,
    packageName,
    componentPkgName,
  )
  await Deno.writeTextFile(distributionPath, distributionContent)

  const pkgName = `${packageId}.unsigned.pkg`

  try {
    const cmd = new Deno.Command("productbuild", {
      args: [
        "--distribution",
        distributionPath,
        "--version",
        version,
        pkgName,
      ],
      cwd: outputDir,
    })
    const { success } = await cmd.output()
    if (!success) {
      throw new Error("productbuild failed")
    }
  } catch (err) {
    throw new Error("productbuild failed")
  }
}

async function signInstaller(
  packageId: string,
  version: string,
  codeSignId: string,
  outputDir: string,
): Promise<void> {
  const unsignedPkgName = `${packageId}.unsigned.pkg`
  const signedPkgName = `${packageId}-${version}.pkg`

  try {
    const cmd = new Deno.Command("productsign", {
      args: [
        "--sign",
        codeSignId,
        unsignedPkgName,
        signedPkgName,
      ],
      cwd: outputDir,
    })
    const { success } = await cmd.output()
    if (!success) {
      throw new Error("productsign failed")
    }
  } catch (err) {
    throw new Error("productsign failed")
  }
}

async function signBundle(
  bundleName: string,
  codeSignId: string,
  outputDir: string,
): Promise<void> {
  const bundleDir = path.join(outputDir, bundleName)

  await builder.exec("security", ["find-identity", "-v", "-p", "codesigning"])
  await builder.exec("security", [
    "unlock-keychain",
    "-p",
    "admin",
    "/Users/admin/Library/Keychains/login.keychain-db",
  ])

  const code = await builder.exec("timeout", [
    "60s",
    "codesign",
    "-f",
    "-v",
    "-s",
    codeSignId,
    bundleDir,
  ], {
    cwd: outputDir,
  })

  if (code !== 0) {
    throw new Error(`bundle signing failed: error code${code}`)
  }
}

async function createComponentPackage(
  outputDir: string,
  bundleDir: string,
  packageName: string,
  version: string,
): Promise<string> {
  const pkgName = `${packageName}.pkg`

  try {
    const cmd = new Deno.Command("pkgbuild", {
      args: [
        "--component",
        bundleDir,
        "--ownership",
        "recommended",
        "--install-location",
        "/Library/Services",
        "--version",
        version,
        pkgName,
      ],
      cwd: outputDir,
    })
    const { success } = await cmd.output()
    if (!success) {
      throw new Error("pkgbuild failed")
    }
  } catch (err) {
    throw new Error("pkgbuild failed")
  }

  return pkgName
}

function makeDistribution(
  packageId: string,
  packageName: string,
  componentPackage: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<installer-gui-script minSpecVersion="2">
    <title>${packageId}</title>
    <options customize="never" rootVolumeOnly="true"/>
    <choices-outline>
        <line choice="default">
            <line choice="${packageName}"/>
        </line>
    </choices-outline>

    <choice id="default" />
    <choice id="${packageName}" visible="false">
        <pkg-ref id="${packageName}"/>
    </choice>

    <pkg-ref id="${packageName}" onConclusion="RequireRestart" version="0" auth="root">${componentPackage}</pkg-ref>
</installer-gui-script>`
}
