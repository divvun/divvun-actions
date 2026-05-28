import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { GitHub } from "~/util/github.ts"
import { makeTempDir } from "~/util/temp.ts"
import { resolveExtensionVersion } from "./version.ts"

export {
  runLibreOfficeExtensionMacosInstaller,
  runLibreOfficeExtensionMacosOxt,
} from "./macos.ts"
export { runLibreOfficeExtensionLinuxOxt } from "./linux.ts"
export {
  runLibreOfficeExtensionWindowsInstaller,
  runLibreOfficeExtensionWindowsOxt,
} from "./windows.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

const ARTIFACTS = [
  "divvunspell-libreoffice-macos.oxt",
  "divvunspell-libreoffice-macos.app.zip",
  "divvunspell-libreoffice-linux-x86_64.oxt",
  "divvunspell-libreoffice-windows-x86_64.oxt",
  "divvunspell-libreoffice-windows-x86_64.exe",
] as const

export function pipelineLibreOfficeExtension(): BuildkitePipeline {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"

  const macosOxtKey = "build-oxt-macos"
  const macosInstallerKey = "installer-macos"
  const linuxOxtKey = "build-oxt-linux"
  const winX64OxtKey = "build-oxt-windows-x86_64"
  const winX64InstallerKey = "installer-windows-x86_64"

  const publishDeps = [
    macosOxtKey,
    macosInstallerKey,
    linuxOxtKey,
    winX64OxtKey,
    winX64InstallerKey,
  ]

  const steps: BuildkitePipeline["steps"] = [
    {
      group: "macOS",
      steps: [
        command({
          key: macosOxtKey,
          label: "Build .oxt",
          agents: { queue: "macos" },
          command: "divvun-actions run libreoffice-extension-build-oxt-macos",
        }),
        command({
          key: macosInstallerKey,
          label: "Build installer",
          agents: { queue: "macos" },
          depends_on: macosOxtKey,
          command: "divvun-actions run libreoffice-extension-installer-macos",
        }),
      ],
    },
    {
      group: "Linux",
      steps: [
        command({
          key: linuxOxtKey,
          label: "Build .oxt",
          agents: { queue: "linux" },
          command: "divvun-actions run libreoffice-extension-build-oxt-linux",
        }),
      ],
    },
    {
      group: "Windows",
      steps: [
        command({
          key: winX64OxtKey,
          label: "Build .oxt",
          agents: { queue: "windows" },
          command:
            "divvun-actions run libreoffice-extension-build-oxt-windows x86_64",
        }),
        command({
          key: winX64InstallerKey,
          label: "Build installer",
          agents: { queue: "windows" },
          depends_on: winX64OxtKey,
          command:
            "divvun-actions run libreoffice-extension-installer-windows x86_64",
        }),
      ],
    },
  ]

  if (isRelease || isMainBranch) {
    steps.push(
      command({
        label: `Publish (${isRelease ? "Release" : "Dev"})`,
        command: "divvun-actions run libreoffice-extension-publish",
        agents: { queue: "linux" },
        depends_on: publishDeps,
      }),
    )
  }

  return { steps }
}

export async function runLibreOfficeExtensionPublish() {
  const isRelease = !!builder.env.tag?.match(/^v/)
  const isMainBranch = builder.env.branch === "main"
  if (!isRelease && !isMainBranch) {
    throw new Error(
      "libreoffice-extension-publish requires a version tag or main branch",
    )
  }
  if (!builder.env.repo) {
    throw new Error("No repo found, cannot publish")
  }

  using tempDir = await makeTempDir({ prefix: "lo-publish-" })

  await Promise.all(
    ARTIFACTS.map((a) => builder.downloadArtifacts(a, tempDir.path)),
  )

  const version = isRelease
    ? builder.env.tag!.replace(/^v/, "")
    : await resolveExtensionVersion()

  using archiveDir = await makeTempDir({ prefix: "lo-publish-versioned-" })
  const versioned: string[] = []
  for (const name of ARTIFACTS) {
    const src = path.join(tempDir.path, name)
    const dest = path.join(archiveDir.path, versionedName(name, version))
    await fs.move(src, dest, { overwrite: true })
    versioned.push(dest)
  }

  const gh = new GitHub(builder.env.repo)
  if (isRelease) {
    await gh.createRelease(builder.env.tag!, versioned, { latest: true })
  } else {
    await gh.updateRelease("dev-latest", versioned, {
      draft: false,
      prerelease: true,
      name: `v${version}`,
    })
  }
}

function versionedName(name: string, version: string): string {
  const idx = name.indexOf(".")
  if (idx < 0) return `${name}-${version}`
  return `${name.slice(0, idx)}-${version}${name.slice(idx)}`
}
