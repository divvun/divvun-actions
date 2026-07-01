import YAML from "yaml"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"
import { makeTempDir } from "~/util/temp.ts"

const K8S_CONFIG_REPO = "git@github.com:divvun/k8s-config.git"
const COMMIT_AUTHOR_NAME = "divvun-actions"
const COMMIT_AUTHOR_EMAIL = "divvun-actions@users.noreply.github.com"

export type BumpKustomizeImageTagOptions = {
  /** Full image name without tag, e.g. "ghcr.io/divvun/borealium". */
  imageName: string
  /** New tag (e.g. "sha-deadbeef"). Replaces any existing digest/tag. */
  tag: string
  /** Path within the k8s-config repo to the kustomization.yaml to edit. */
  kustomizationPath: string
  /** Commit message for the bump. */
  commitMessage: string
}

export type BumpArgoHelmImageTagOptions = {
  /** Full image name without tag, e.g. "ghcr.io/divvun/keyboard-viewer". */
  imageName: string
  /** New tag (e.g. "sha-deadbeef"). Replaces the Helm values image.tag. */
  tag: string
  /** Path within the k8s-config repo to the Argo CD Application manifest. */
  applicationPath: string
  /** Commit message for the bump. */
  commitMessage: string
}

export type BumpChartImageTagOptions = {
  /** Full image name without tag, e.g. "ghcr.io/divvun/divvun-worker-grammar". */
  imageName: string
  /** New tag (e.g. "sha-deadbeef"). */
  tag: string
  /** Path within the k8s-config repo to the chart's values.yaml. */
  valuesPath: string
  /** Top-level image key in the values, e.g. "workerImage" or "image". */
  imageKey: string
  /** Commit message for the bump. */
  commitMessage: string
}

type UpdateK8sConfigFileOptions = {
  /** Path within the k8s-config repo to edit. */
  path: string
  /** Commit message for the update. */
  commitMessage: string
  /** Returns the new file contents. */
  update: (source: string) => string | Promise<string>
}

async function updateK8sConfigFile(
  opts: UpdateK8sConfigFileOptions,
): Promise<void> {
  await using tempDir = await makeTempDir({ prefix: "k8s-config-bump-" })

  const git = (args: string[], cwd: string) =>
    builder.exec("git", args, { cwd })

  await git(
    ["clone", "--depth", "1", K8S_CONFIG_REPO, "k8s-config"],
    tempDir.path,
  )

  const repoDir = `${tempDir.path}/k8s-config`
  const manifestPath = `${repoDir}/${opts.path}`
  const source = await Deno.readTextFile(manifestPath)
  await Deno.writeTextFile(manifestPath, await opts.update(source))

  const diff = await builder.output("git", [
    "diff",
    "--quiet",
    "--",
    opts.path,
  ], { cwd: repoDir })
  if (diff.status.code === 0) {
    logger.info(`No k8s-config changes needed for ${opts.path}`)
    return
  }
  if (diff.status.code !== 1) {
    throw new Error(`git diff --quiet failed: ${diff.stderr}`)
  }

  await git(["config", "user.name", COMMIT_AUTHOR_NAME], repoDir)
  await git(["config", "user.email", COMMIT_AUTHOR_EMAIL], repoDir)
  await git(["add", opts.path], repoDir)
  await git(["commit", "-m", opts.commitMessage], repoDir)
  await git(["push", "origin", "HEAD"], repoDir)
}

export async function bumpKustomizeImageTag(
  opts: BumpKustomizeImageTagOptions,
): Promise<void> {
  await updateK8sConfigFile({
    path: opts.kustomizationPath,
    commitMessage: opts.commitMessage,
    update(source) {
      const doc = YAML.parseDocument(source)

      const images = doc.get("images") as YAML.YAMLSeq | null
      if (!images || !YAML.isSeq(images)) {
        throw new Error(`No images: sequence in ${opts.kustomizationPath}`)
      }
      const entry = images.items.find((item) =>
        YAML.isMap(item) && item.get("name") === opts.imageName
      ) as YAML.YAMLMap | undefined
      if (!entry) {
        throw new Error(
          `No images entry for ${opts.imageName} in ${opts.kustomizationPath}`,
        )
      }
      entry.set("newTag", opts.tag)
      entry.delete("digest")

      return String(doc)
    },
  })
}

export async function bumpArgoHelmImageTag(
  opts: BumpArgoHelmImageTagOptions,
): Promise<void> {
  await updateK8sConfigFile({
    path: opts.applicationPath,
    commitMessage: opts.commitMessage,
    update(source) {
      const doc = YAML.parseDocument(source)
      const helm = doc.getIn(["spec", "source", "helm"]) as
        | YAML.YAMLMap
        | null
      if (!helm || !YAML.isMap(helm)) {
        throw new Error(`No spec.source.helm map in ${opts.applicationPath}`)
      }

      const valuesSource = helm.get("values")
      if (typeof valuesSource !== "string") {
        throw new Error(
          `No spec.source.helm.values string in ${opts.applicationPath}`,
        )
      }

      const valuesDoc = YAML.parseDocument(valuesSource)
      const image = valuesDoc.get("image") as YAML.YAMLMap | null
      if (!image || !YAML.isMap(image)) {
        throw new Error(`No image map in ${opts.applicationPath} Helm values`)
      }
      if (image.get("repository") !== opts.imageName) {
        throw new Error(
          `Expected image.repository ${opts.imageName} in ${opts.applicationPath}`,
        )
      }
      image.set("tag", opts.tag)
      helm.set("values", String(valuesDoc))

      return String(doc)
    },
  })
}

/**
 * Bump an image tag in a chart's `values.yaml` — a plain data file, so this is
 * a straight YAML edit (unlike an ApplicationSet, whose `helm.values` is a
 * Go-templated string). Used to pin worker images: the ApplicationSets defer to
 * the chart default, and CD patches the default here.
 */
export async function bumpChartImageTag(
  opts: BumpChartImageTagOptions,
): Promise<void> {
  await updateK8sConfigFile({
    path: opts.valuesPath,
    commitMessage: opts.commitMessage,
    update(source) {
      const doc = YAML.parseDocument(source)
      const image = doc.get(opts.imageKey) as YAML.YAMLMap | null
      if (!image || !YAML.isMap(image)) {
        throw new Error(`No ${opts.imageKey} map in ${opts.valuesPath}`)
      }
      if (image.get("repository") !== opts.imageName) {
        throw new Error(
          `Expected ${opts.imageKey}.repository ${opts.imageName} in ${opts.valuesPath}`,
        )
      }
      image.set("tag", opts.tag)
      return String(doc)
    },
  })
}
