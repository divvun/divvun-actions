import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { makeOuttoInstaller } from "~/actions/outto/lib.ts"
import sign from "~/services/windows-codesign.ts"
import * as target from "~/target.ts"
import { OuttoBuilder } from "~/util/outto.ts"
import { makeTempDir } from "~/util/temp.ts"

export type DebuggerPackage = {
  id: string
  version: string
  url: string
  sha256: string
  files: Array<{ member: string; filename: string }>
}

export type WindProduct = {
  id: string
  name: string
  publisher: string
  default_dir: string
  catalogue_dir: string
  payloads: string[]
  debugger_packages: DebuggerPackage[]
}

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

export function windManifest(
  stage: string,
  product: WindProduct,
  version: string,
): string {
  const manifest = new OuttoBuilder(stage, "windows")
    .id(product.id)
    .name(product.name)
    .publisher(product.publisher)
    .version(version)
    .url("https://divvun.no/")
    .architecture("x64")
    .privileges("admin")
    .defaultDir(`${product.default_dir}/versions/${version}`)
    .upgradePolicy("overwrite")
    .restartManager(false)
    .removeAppDirOnUninstall(false)
    .dir({ path: product.catalogue_dir, preserve_on_uninstall: true })
    .registry({
      root: "hklm",
      key: "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      values: [{
        name: "DivvunWind",
        type: "string",
        data: '"#{app}/divvun-wind.exe" run',
      }],
      uninstall: "remove_values",
    })
    .shortcut({
      name: "Divvun Wind",
      target: "#{app}/divvun-wind.exe",
      arguments: "run",
      location: "start_menu",
    })

  for (
    const name of [
      ...product.payloads,
      ...product.debugger_packages.flatMap((p) =>
        p.files.map((f) => f.filename)
      ),
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "THIRD-PARTY-NOTICES.md",
    ]
  ) {
    manifest.file({ source: name, dest: "#{app}", overwrite: "always" })
  }
  return manifest.build()
}

export async function bundleWind(opts: {
  product: WindProduct
  version: string
  payloadDir: string
  outputPath: string
  signed: boolean
}): Promise<{ installer: string; manifest: string; provenance: string }> {
  const toolkit = await builder.output("pwsh", [
    "-NoProfile",
    "-File",
    path.join(target.projectPath, "actions/divvun-wind/outto-toolchain.ps1"),
  ])
  if (!toolkit.status.success) {
    throw new Error(`Invalid outto toolkit: ${toolkit.stderr}`)
  }
  const outtoToolchain: unknown = JSON.parse(toolkit.stdout)
  using stage = await makeTempDir({ prefix: "wind-outto-" })
  for (const name of opts.product.payloads) {
    const file = path.join(stage.path, name)
    await Deno.copyFile(path.join(opts.payloadDir, name), file)
    if (opts.signed) await sign(file)
  }
  for (
    const name of ["LICENSE-MIT", "LICENSE-APACHE", "THIRD-PARTY-NOTICES.md"]
  ) {
    await Deno.copyFile(name, path.join(stage.path, name))
  }
  for (const pkg of opts.product.debugger_packages) {
    const archive = path.join(stage.path, `${pkg.id}.zip`)
    const response = await fetch(pkg.url)
    if (!response.ok) {
      throw new Error(`Download ${pkg.id}: HTTP ${response.status}`)
    }
    await Deno.writeFile(archive, new Uint8Array(await response.arrayBuffer()))
    if (await sha256(archive) !== pkg.sha256) {
      throw new Error(`Checksum mismatch: ${pkg.id}`)
    }
    for (const file of pkg.files) {
      await builder.exec("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(
          target.projectPath,
          "actions/divvun-wind/extract-debugger.ps1",
        ),
        "-Archive",
        archive,
        "-Member",
        file.member,
        "-Output",
        path.join(stage.path, file.filename),
      ])
    }
    await Deno.remove(archive)
    // Preserve Microsoft's original signature; sign only Divvun's payloads.
  }

  const configPath = path.join(stage.path, "outto.toml")
  await Deno.writeTextFile(
    configPath,
    windManifest(stage.path, opts.product, opts.version),
  )
  const inner = path.join(stage.path, "wind-outto.exe")
  await makeOuttoInstaller({
    configPath,
    sourceDir: stage.path,
    outputPath: inner,
    target: "windows",
    ...(opts.signed
      ? {
        signCommand:
          `call "${target.projectPath}\\bin\\divvun-actions.bat" sign "#{file}"`,
      }
      : {}),
  })
  // The public executable applies Wind's Windows 11 gate before outto starts.
  await builder.exec("pwsh", [
    "-NoProfile",
    "-File",
    "scripts/build-installer.ps1",
    "-Payload",
    inner,
    "-Output",
    path.resolve(opts.outputPath),
  ])
  if (opts.signed) await sign(opts.outputPath)

  const manifest = opts.outputPath.replace(/\.exe$/, ".outto.toml")
  const provenance = opts.outputPath.replace(/\.exe$/, ".build.json")
  await Deno.copyFile(configPath, manifest)
  const hashes: Record<string, string> = {}
  for (
    const name of [
      ...opts.product.payloads,
      ...opts.product.debugger_packages.flatMap((p) =>
        p.files.map((f) => f.filename)
      ),
    ]
  ) {
    hashes[name] = await sha256(path.join(stage.path, name))
  }
  await Deno.writeTextFile(
    provenance,
    JSON.stringify(
      {
        version: opts.version,
        commit: builder.env.commit,
        divvun_actions_revision: target.gitHash,
        signed: opts.signed,
        outto_toolchain: outtoToolchain,
        installer_sha256: await sha256(opts.outputPath),
        payload_sha256: hashes,
        debugger_packages: opts.product.debugger_packages,
      },
      null,
      2,
    ) + "\n",
  )
  return { installer: opts.outputPath, manifest, provenance }
}
