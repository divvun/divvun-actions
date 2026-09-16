import * as path from "@std/path"
import * as toml from "@std/toml"
import { parse as parseVersion } from "@std/semver"
import * as builder from "~/builder.ts"
import {
  bundleMsgrammar,
  MSGRAMMAR_PAYLOADS,
  MSGRAMMAR_TARGET,
  sha256,
} from "~/actions/msgrammar/bundle.ts"
import type { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { assetStem, assetTarget } from "~/util/asset_name.ts"
import { GitHub } from "~/util/github.ts"
import { versionAsDev } from "~/util/shared.ts"
import { makeTempDir } from "~/util/temp.ts"

const BUILD = `check-build-${MSGRAMMAR_TARGET}`
const PACKAGE = `installer-${MSGRAMMAR_TARGET}`
const INSTALLER = `msgrammar_${assetTarget(MSGRAMMAR_TARGET)}.exe`

export function msgrammarReleaseMode(): "release" | "dev" | null {
  if (builder.env.pullRequest && builder.env.pullRequest !== "false") {
    return null
  }
  if (builder.env.tag) {
    if (!builder.env.tag.startsWith("v")) return null
    try {
      parseVersion(builder.env.tag.slice(1))
      return "release"
    } catch {
      return null
    }
  }
  return builder.env.branch === "main" ? "dev" : null
}

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

export function pipelineMsgrammar(): BuildkitePipeline {
  const mode = msgrammarReleaseMode()
  const steps: BuildkitePipeline["steps"] = [
    command({
      key: BUILD,
      label: "Windows x64: check, test, build",
      agents: { queue: "windows" },
      command: "pwsh -NoProfile -File scripts/buildkite.ps1",
      timeout_in_minutes: 45,
    }),
    command({
      key: PACKAGE,
      label: `Windows x64: outto installer (${mode ? "signed" : "unsigned"})`,
      agents: { queue: "windows" },
      depends_on: BUILD,
      command: "divvun-actions run msgrammar-installer",
      timeout_in_minutes: 30,
    }),
  ]
  if (mode) {
    steps.push(command({
      key: "publish",
      label: `Publish (${mode === "release" ? "Release" : "dev-latest"})`,
      agents: { queue: "linux" },
      depends_on: [BUILD, PACKAGE],
      command: "divvun-actions run msgrammar-publish",
      concurrency: 1,
      concurrency_group: "msgrammar/releases",
    }))
  }
  return { steps }
}

export async function msgrammarVersion(): Promise<string> {
  const cargo = toml.parse(await Deno.readTextFile("Cargo.toml")) as {
    workspace: { package: { version: string } }
  }
  const base = cargo.workspace.package.version
  parseVersion(base)
  if (msgrammarReleaseMode() === "release") {
    const tagged = builder.env.tag!.slice(1)
    if (tagged !== base) {
      throw new Error(`Tag ${tagged} does not match Cargo version ${base}`)
    }
    return tagged
  }
  return versionAsDev(base, builder.env.buildTimestamp, builder.env.buildNumber)
}

export async function runMsgrammarInstaller() {
  const version = await msgrammarVersion()
  using downloaded = await makeTempDir({ prefix: "msgrammar-binaries-" })
  for (const name of [...MSGRAMMAR_PAYLOADS, "msgrammar-build.json"]) {
    await builder.exec("buildkite-agent", [
      "artifact",
      "download",
      path.join("target", MSGRAMMAR_TARGET, "release", name),
      downloaded.path,
      "--step",
      BUILD,
    ])
  }
  const signed = msgrammarReleaseMode() !== null
  const result = await bundleMsgrammar({
    version,
    payloadDir: path.join(
      downloaded.path,
      "target",
      MSGRAMMAR_TARGET,
      "release",
    ),
    outputPath: path.resolve(
      signed ? INSTALLER : INSTALLER.replace(".exe", ".UNSIGNED.exe"),
    ),
    signed,
  })
  for (const file of Object.values(result)) await builder.uploadArtifacts(file)
}

export async function verifyMsgrammarInstaller(
  artifacts: string,
  expectedVersion?: string,
): Promise<string> {
  const record = JSON.parse(
    await Deno.readTextFile(
      path.join(artifacts, INSTALLER.replace(".exe", ".build.json")),
    ),
  )
  if (
    record.signed !== true || record.commit !== builder.env.commit ||
    record.target !== MSGRAMMAR_TARGET ||
    (expectedVersion !== undefined && record.version !== expectedVersion)
  ) {
    throw new Error("Installer provenance does not match this signed build")
  }
  parseVersion(record.version)
  if (
    await sha256(path.join(artifacts, INSTALLER)) !== record.installer_sha256 ||
    await sha256(
        path.join(artifacts, INSTALLER.replace(".exe", ".outto.toml")),
      ) !== record.manifest_sha256
  ) {
    throw new Error("Installer or manifest checksum does not match provenance")
  }
  return record.version
}

export async function runMsgrammarPublish() {
  const mode = msgrammarReleaseMode()
  if (!mode || !builder.env.repo) {
    throw new Error(
      "msgrammar publication requires main or a version tag, outside a pull request",
    )
  }
  const expectedVersion = mode === "release"
    ? await msgrammarVersion()
    : undefined
  using artifacts = await makeTempDir({ prefix: "msgrammar-publish-" })
  const names = [
    INSTALLER,
    INSTALLER.replace(".exe", ".outto.toml"),
    INSTALLER.replace(".exe", ".build.json"),
  ]
  for (const name of names) {
    await builder.exec("buildkite-agent", [
      "artifact",
      "download",
      name,
      artifacts.path,
      "--step",
      PACKAGE,
    ])
  }
  const version = await verifyMsgrammarInstaller(artifacts.path, expectedVersion)
  const releaseStem = assetStem("msgrammar", MSGRAMMAR_TARGET, version)
  const files: string[] = []
  for (const name of names) {
    const destination = path.join(
      artifacts.path,
      name.replace(INSTALLER.slice(0, -4), releaseStem),
    )
    await Deno.rename(path.join(artifacts.path, name), destination)
    files.push(destination)
  }
  const sums = path.join(artifacts.path, "SHA256SUMS")
  await Deno.writeTextFile(
    sums,
    (await Promise.all(
      files.map(async (file) =>
        `${await sha256(file)}  ${path.basename(file)}`
      ),
    )).join("\n") + "\n",
  )
  files.push(sums)
  const gh = new GitHub(builder.env.repo)
  if (mode === "release") {
    const prerelease = (parseVersion(version).prerelease?.length ?? 0) > 0
    await gh.createRelease(builder.env.tag!, files, {
      latest: !prerelease,
      prerelease,
      name: `v${version}`,
    })
  } else {
    await gh.updateRelease("dev-latest", files, {
      draft: false,
      prerelease: true,
      name: `v${version}`,
    })
  }
}
