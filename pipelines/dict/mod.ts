import * as fs from "@std/fs"
import * as semver from "@std/semver"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as target from "~/target.ts"
import { globOneDir, globOneFile } from "~/util/glob.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import logger from "~/util/log.ts"
import { versionAsDev } from "~/util/shared.ts"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${target.gitHash}`,
    ],
  }
}

export type DictManifest = {
  package: {
    dict: {
      name: string
      version: string
      bundle_identifier: string
      source_lang: string
      target_lang: string
    }
  }
}

const DICT_RELEASE_TAG = /^dict-(.*?)\/v\d+\.\d+\.\d+(-\S+)?$/

function extractVersionFromTag(tag: string): string | null {
  const match = tag.match(/\/v(\d+\.\d+\.\d+(?:-\S+)?)$/)
  return match ? match[1] : null
}

function isPrerelease(version: string): boolean {
  try {
    const parsed = semver.parse(version)
    return parsed.major === 0 || (parsed.prerelease?.length ?? 0) > 0
  } catch {
    return false
  }
}

function parsePair(repoName: string): string {
  const m = repoName.match(/^dict-(.+)$/)
  if (!m) {
    throw new Error(`Repo name does not start with "dict-": ${repoName}`)
  }
  return m[1]
}

async function readManifest(): Promise<DictManifest> {
  let raw: string
  try {
    raw = await Deno.readTextFile("./manifest.toml")
  } catch (e) {
    throw new Error(
      `manifest.toml not found in repo root; add a [package.dict] block. ${e}`,
    )
  }
  const parsed = toml.parse(raw) as DictManifest
  if (!parsed.package?.dict) {
    throw new Error("manifest.toml is missing [package.dict] block")
  }
  const d = parsed.package.dict
  const required: (keyof typeof d)[] = [
    "name",
    "version",
    "bundle_identifier",
    "source_lang",
    "target_lang",
  ]
  for (const key of required) {
    if (!d[key]) {
      throw new Error(
        `manifest.toml [package.dict] missing required field: ${key}`,
      )
    }
  }
  return parsed
}

async function run(cmd: string, args: string[]) {
  logger.info(`$ ${cmd} ${args.join(" ")}`)
  const proc = new Deno.Command(cmd, { args }).spawn()
  const { code } = await proc.output()
  if (code !== 0) {
    throw new Error(`${cmd} failed: exit code ${code}`)
  }
}

export async function runDictBuild() {
  const manifest = await readManifest()
  const pkg = manifest.package.dict
  const sourceLang = pkg.source_lang

  const fstRepo = `giellalt/lang-${sourceLang}`
  const fstReleaseTag = `speller-${sourceLang}/dev-latest`
  const fstAssetPattern = `fst-${sourceLang}_*_noarch-all.pkt.tar.zst`

  logger.info(`Downloading FST from ${fstRepo}@${fstReleaseTag}`)
  await run("gh", [
    "release",
    "download",
    fstReleaseTag,
    "--repo",
    fstRepo,
    "--pattern",
    fstAssetPattern,
  ])

  const fstArchive = await globOneFile(fstAssetPattern)
  if (!fstArchive) {
    throw new Error(`No FST archive matched ${fstAssetPattern} after download`)
  }

  await Deno.mkdir("fst-extract", { recursive: true })
  await run("tar", ["--zstd", "-xf", fstArchive, "-C", "fst-extract"])

  const generatorPath = "fst-extract/generator-gt-norm.hfstol"
  if (!(await fs.exists(generatorPath))) {
    throw new Error(`${generatorPath} not found in FST bundle`)
  }

  await Deno.mkdir("build", { recursive: true })
  await run("divvun-macdict", [
    "build",
    "--manifest",
    "manifest.toml",
    "--source",
    ".",
    "--generator",
    generatorPath,
    "--out",
    "build",
  ])

  const bundlePath = await globOneDir("build/*.dictionary")
  if (!bundlePath) {
    throw new Error("No .dictionary bundle produced by divvun-macdict")
  }

  logger.info(`Packaging ${bundlePath}`)
  await run("ditto", [
    "-c",
    "-k",
    "--keepParent",
    bundlePath,
    "dict-bundle.zip",
  ])

  await builder.uploadArtifacts("dict-bundle.zip")
  await builder.setMetadata("dict-version", pkg.version)
}

export async function runDictDeploy() {
  if (!builder.env.repo) {
    throw new Error("No repository information available")
  }

  const isDictReleaseTag = DICT_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"

  const manifest = await readManifest()
  const pkg = manifest.package.dict
  const pair = parsePair(builder.env.repoName)
  const packageName = `dict-${pair}`

  await builder.downloadArtifacts("dict-bundle.zip", ".")
  if (!(await fs.exists("dict-bundle.zip"))) {
    throw new Error("dict-bundle.zip not found for deployment")
  }

  if (isDictReleaseTag) {
    if (!builder.env.tag) {
      throw new Error("No tag information available")
    }
    const tagVersion = extractVersionFromTag(builder.env.tag)
    if (!tagVersion) {
      throw new Error(`Could not extract version from tag: ${builder.env.tag}`)
    }
    const prerelease = isPrerelease(tagVersion)
    const versionWithBuild = builder.env.buildNumber
      ? `${tagVersion}+build.${builder.env.buildNumber}`
      : tagVersion

    const versionedFile =
      `${packageName}_${versionWithBuild}_noarch-macos.dictionary.zip`
    await Deno.rename("dict-bundle.zip", versionedFile)

    const { checksumFile, signatureFile } = await createSignedChecksums(
      [versionedFile],
      await builder.secrets(),
    )

    logger.info(`Creating GitHub release for dictionary version ${tagVersion}`)
    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [versionedFile, checksumFile, signatureFile],
      { prerelease },
    )
    logger.info("Dictionary GitHub release created successfully")
  } else if (isMainBranch) {
    const devVersion = versionAsDev(
      pkg.version,
      builder.env.buildTimestamp,
      builder.env.buildNumber,
    )

    const releaseTag = `${packageName}/dev-latest`
    const versionedFile =
      `${packageName}_${devVersion}_noarch-macos.dictionary.zip`
    await Deno.rename("dict-bundle.zip", versionedFile)

    const { checksumFile, signatureFile } = await createSignedChecksums(
      [versionedFile],
      await builder.secrets(),
    )

    logger.info(
      `Updating dev-latest GitHub release for dictionary version ${devVersion}`,
    )
    const releaseName = `${packageName}/v${devVersion}`
    const gh = new GitHub(builder.env.repo)
    await gh.updateRelease(
      releaseTag,
      [versionedFile, checksumFile, signatureFile],
      { draft: false, prerelease: true, name: releaseName },
    )
    logger.info("Dictionary dev-latest GitHub release updated successfully")
  } else {
    logger.info(
      `Not a release tag or main branch (branch=${builder.env.branch}, tag=${builder.env.tag}); skipping deploy`,
    )
  }
}

export function pipelineDict(): BuildkitePipeline {
  const isDictReleaseTag = DICT_RELEASE_TAG.test(builder.env.tag ?? "")
  const isMainBranch = builder.env.branch === "main"
  const isDeploy = isDictReleaseTag || isMainBranch

  const buildSteps: CommandStep[] = [
    command({
      key: "dict-build",
      label: "Build Dictionary",
      command: "divvun-actions run dict-build",
      agents: { queue: "macos" },
    }),
  ]

  const deploySteps: CommandStep[] = []
  if (isDeploy) {
    deploySteps.push(
      command({
        label: `Deploy Dictionary (${isDictReleaseTag ? "Release" : "Dev"})`,
        command: "divvun-actions run dict-deploy",
        depends_on: "dict-build",
        agents: { queue: "linux" },
      }),
    )
  }

  // deno-lint-ignore no-explicit-any
  const steps: any[] = [
    { group: "Build", key: "build", steps: buildSteps },
  ]
  if (deploySteps.length > 0) {
    steps.push({ group: "Deploy", key: "deploy", steps: deploySteps })
  }

  return { steps }
}
