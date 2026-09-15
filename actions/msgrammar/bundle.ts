import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeOuttoInstaller, windowsOuttoSigning } from "~/actions/outto/lib.ts"
import sign from "~/services/windows-codesign.ts"
import * as target from "~/target.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { makeTempDir } from "~/util/temp.ts"

export const MSGRAMMAR_TARGET = "x86_64-pc-windows-msvc"
export const MSGRAMMAR_PAYLOADS = [
  "msgrammar_addin.dll",
  "msgrammar-worker.exe",
  "msgrammar-install.exe",
  "msgrammar-probe.exe",
] as const
const SCRIPTS = [
  "Install-WordAddin.ps1",
  "Register-WordAddin.ps1",
  "New-WordAddinPackage.ps1",
] as const

export async function sha256(file: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(file),
  )
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("")
}

export function msgrammarManifest(stage: string, version: string): string {
  const manifest = new OuttoBuilder(stage, "windows")
    .id("no.divvun.msgrammar")
    .name("Divvun Word Add-in")
    .publisher("Divvun")
    .version(version)
    .url("https://divvun.no/")
    .architecture("x64")
    .privileges("user")
    .defaultDir("#{localappdata}/Divvun/WordAddin/setup")
    .upgradePolicy("overwrite")
    .restartManager(false)
    .removeAppDirOnUninstall(false)
    .run({
      phase: "after_install",
      command: "#{sys}/WindowsPowerShell/v1.0/powershell.exe",
      arguments:
        '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "#{app}/Install-WordAddin.ps1"',
      wait: true,
      show: "hidden",
    })
  for (const name of [...MSGRAMMAR_PAYLOADS, ...SCRIPTS, "INSTALL.md"]) {
    manifest.file({ source: name, dest: "#{app}", overwrite: "always" })
  }
  return manifest.build()
}

type BuildRecord = {
  version: number
  commit: string
  target: string
  signed: boolean
  checks: string[]
  files: Array<{ path: string; bytes: number; sha256: string }>
}

export async function verifyMsgrammarBuild(
  payloadDir: string,
  commit: string,
): Promise<BuildRecord> {
  const record: BuildRecord = JSON.parse(
    await Deno.readTextFile(path.join(payloadDir, "msgrammar-build.json")),
  )
  if (
    record.version !== 1 || record.commit !== commit ||
    record.target !== MSGRAMMAR_TARGET || record.signed !== false ||
    !["format", "lint", "test", "powershell", "release-build"].every((check) =>
      record.checks.includes(check)
    )
  ) {
    throw new Error("Build provenance does not match the checked Windows build")
  }
  for (const name of MSGRAMMAR_PAYLOADS) {
    const file = path.join(payloadDir, name)
    const records = record.files.filter((f) =>
      f.path === `target/${MSGRAMMAR_TARGET}/release/${name}`
    )
    if (
      records.length !== 1 || records[0].bytes <= 0 ||
      records[0].bytes !== (await Deno.stat(file)).size ||
      records[0].sha256 !== await sha256(file)
    ) {
      throw new Error(`Build artifact does not match provenance: ${name}`)
    }
  }
  return record
}

export async function bundleMsgrammar(opts: {
  version: string
  payloadDir: string
  outputPath: string
  signed: boolean
}): Promise<{ installer: string; manifest: string; provenance: string }> {
  if (!builder.env.commit) throw new Error("Build commit is unavailable")
  const sourceBuild = await verifyMsgrammarBuild(
    opts.payloadDir,
    builder.env.commit,
  )
  using stage = await makeTempDir({ prefix: "msgrammar-outto-" })
  const hashes: Record<string, string> = {}
  for (const name of MSGRAMMAR_PAYLOADS) {
    const file = path.join(stage.path, name)
    await Deno.copyFile(path.join(opts.payloadDir, name), file)
    if (opts.signed) await sign(file)
    hashes[name] = await sha256(file)
  }
  for (const name of SCRIPTS) {
    await Deno.copyFile(path.join("scripts", name), path.join(stage.path, name))
    hashes[name] = await sha256(path.join(stage.path, name))
  }
  await Deno.copyFile("docs/install.md", path.join(stage.path, "INSTALL.md"))
  const configPath = path.join(stage.path, "outto.toml")
  await Deno.writeTextFile(
    configPath,
    msgrammarManifest(stage.path, opts.version),
  )
  await makeOuttoInstaller({
    configPath,
    sourceDir: stage.path,
    outputPath: path.resolve(opts.outputPath),
    target: "windows",
    compress: true,
    ...(opts.signed
      ? windowsOuttoSigning(
        path.join(target.projectPath, "bin/divvun-actions.bat"),
      )
      : {}),
  })
  const manifest = opts.outputPath.replace(/\.exe$/, ".outto.toml")
  const provenance = opts.outputPath.replace(/\.exe$/, ".build.json")
  await Deno.copyFile(configPath, manifest)
  await Deno.writeTextFile(
    provenance,
    JSON.stringify(
      {
        version: opts.version,
        commit: builder.env.commit,
        target: MSGRAMMAR_TARGET,
        divvun_actions_revision: target.gitHash,
        signed: opts.signed,
        installer_sha256: await sha256(opts.outputPath),
        manifest_sha256: await sha256(manifest),
        payload_sha256: hashes,
        source_build: sourceBuild,
      },
      null,
      2,
    ) + "\n",
  )
  return { installer: opts.outputPath, manifest, provenance }
}
