import * as path from "@std/path"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import {
  bundleWind,
  sha256,
  type WindProduct,
} from "~/actions/divvun-wind/bundle.ts"
import type { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { assetStem, assetTarget } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import { versionAsDev } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const TARGET = "x86_64-pc-windows-msvc"
const INSTALLER = `divvun-wind_${assetTarget(TARGET)}.exe`
const BUILD = `check-build-${TARGET}`
const PACKAGE = `installer-${TARGET}`

export function windReleaseMode(): "release" | "dev" | null {
  if (builder.env.pullRequest && builder.env.pullRequest !== "false") {
    return null
  }
  if (builder.env.tag) {
    return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
        builder.env.tag,
      )
      ? "release"
      : null
  }
  return builder.env.branch === "main" ? "dev" : null
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineDivvunWind(): BuildkitePipeline {
  const steps: BuildkitePipeline["steps"] = [
    command({
      key: BUILD,
      label: "Windows x64: check, test, build",
      agents: { queue: "windows" },
      command: "pwsh -NoProfile -File scripts/buildkite.ps1",
    }),
    command({
      key: PACKAGE,
      label: `Windows x64: outto installer${
        windReleaseMode() ? " (signed)" : " (unsigned)"
      }`,
      agents: { queue: "windows" },
      depends_on: BUILD,
      command: "divvun-actions run divvun-wind-installer",
    }),
  ]
  if (windReleaseMode()) {
    steps.push(command({
      key: "publish",
      label: `Publish (${
        windReleaseMode() === "release" ? "Release" : "dev-latest"
      })`,
      agents: { queue: "linux" },
      depends_on: [BUILD, PACKAGE],
      command: "divvun-actions run divvun-wind-publish",
      concurrency: 1,
      concurrency_group: "divvun-wind/releases",
    }))
  }
  return { steps }
}

async function version(): Promise<string> {
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    workspace: { package: { version: string } }
  }
  const base = cargo.workspace.package.version
  if (windReleaseMode() === "release") {
    const tagged = builder.env.tag!.slice(1)
    if (tagged !== base) {
      throw new Error(`Tag ${tagged} does not match Cargo version ${base}`)
    }
    return tagged
  }
  return versionAsDev(base, builder.env.buildTimestamp, builder.env.buildNumber)
}

export async function runWindInstaller() {
  const product: WindProduct = JSON.parse(
    await Deno.readTextFile("packaging/product.json"),
  )
  using downloaded = await makeTempDir({ prefix: "wind-binaries-" })
  for (const name of product.payloads) {
    await builder.downloadArtifacts(
      path.join("target", TARGET, "release", name),
      downloaded.path,
    )
  }
  const signed = windReleaseMode() !== null
  const result = await bundleWind({
    product,
    version: await version(),
    payloadDir: path.join(downloaded.path, "target", TARGET, "release"),
    outputPath: path.resolve(
      signed ? INSTALLER : INSTALLER.replace(".exe", ".UNSIGNED.exe"),
    ),
    signed,
  })
  for (const file of Object.values(result)) await builder.uploadArtifacts(file)
}

export async function runWindPublish() {
  const mode = windReleaseMode()
  if (!mode || !builder.env.repo) {
    throw new Error(
      "Wind publication requires main or a version tag, outside a pull request",
    )
  }
  using artifacts = await makeTempDir({ prefix: "wind-publish-" })
  const names = [
    INSTALLER,
    INSTALLER.replace(".exe", ".outto.toml"),
    INSTALLER.replace(".exe", ".build.json"),
  ]
  for (const name of names) {
    await builder.downloadArtifacts(name, artifacts.path)
  }
  const record = JSON.parse(
    await Deno.readTextFile(path.join(artifacts.path, names[2])),
  )
  if (record.signed !== true || record.commit !== builder.env.commit) {
    throw new Error("Installer provenance does not match this signed build")
  }
  if (
    await sha256(path.join(artifacts.path, INSTALLER)) !==
      record.installer_sha256
  ) throw new Error("Installer checksum does not match provenance")
  const releaseStem = assetStem("divvun-wind", TARGET, record.version)
  const files: string[] = []
  for (const name of names) {
    const source = path.join(artifacts.path, name)
    const destination = path.join(
      artifacts.path,
      name.replace(INSTALLER.slice(0, -4), releaseStem),
    )
    await Deno.rename(source, destination)
    files.push(destination)
  }
  const { checksumFile, signatureFile } = await createSignedChecksums(
    files.map((file) => path.basename(file)),
    await builder.secrets(),
    artifacts.path,
  )
  files.push(checksumFile, signatureFile)
  const gh = new GitHub(builder.env.repo)
  if (mode === "release") {
    await gh.createRelease(builder.env.tag!, files, {
      latest: true,
      name: `v${record.version}`,
    })
  } else {
    await gh.updateRelease("dev-latest", files, {
      draft: false,
      prerelease: true,
      name: `v${record.version}`,
    })
  }
}
