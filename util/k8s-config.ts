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

export type PinArgoKustomizeImageDigestOptions = {
  /** Full image name without tag, e.g. "ghcr.io/divvun/pahkat-server". */
  imageName: string
  /**
   * The pushed image's digest, `sha256:` and 64 hex digits. Replaces any
   * existing tag or digest.
   */
  digest: string
  /** Path within the k8s-config repo to the Argo CD Application manifest. */
  applicationPath: string
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
 * The image an Argo CD kustomize image override deploys, without its tag or
 * digest. An override is `[<name in the manifests>=]<image>[:<tag>|@<digest>]`,
 * and a registry host may carry a port, so only a colon after the last slash
 * starts a tag.
 */
function kustomizeOverrideImage(override: string): string {
  const image = override.slice(override.indexOf("=") + 1).split("@")[0]
  const tagStart = image.indexOf(":", image.lastIndexOf("/") + 1)
  return tagStart === -1 ? image : image.slice(0, tagStart)
}

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/

function kustomizeOverrides(
  doc: YAML.Document,
  imageName: string,
  applicationPath: string,
): YAML.Scalar<string>[] {
  const images = doc.getIn(["spec", "source", "kustomize", "images"])
  if (!YAML.isSeq(images)) {
    throw new Error(
      `No spec.source.kustomize.images sequence in ${applicationPath}`,
    )
  }
  return images.items.filter((item) =>
    YAML.isScalar(item) && typeof item.value === "string" &&
    kustomizeOverrideImage(item.value) === imageName
  ) as YAML.Scalar<string>[]
}

/**
 * The Application `source` with its kustomize image override for
 * `imageName` pinned to `digest`, as `<image>@sha256:<hex>`. A tag can be
 * pushed again to name other content, so the cluster is only bound to the
 * image CI built and pushed by its digest. Anything but a sha256 digest is
 * refused, and the pin is read back from the output, so an update can never
 * leave the override pinned by a tag.
 */
export function pinArgoKustomizeImage(
  source: string,
  opts: Pick<
    PinArgoKustomizeImageDigestOptions,
    "imageName" | "digest" | "applicationPath"
  >,
): string {
  if (!IMAGE_DIGEST.test(opts.digest)) {
    throw new Error(
      `Refusing to pin ${opts.imageName} to ${
        JSON.stringify(opts.digest)
      }, which is not a sha256 digest`,
    )
  }

  const doc = YAML.parseDocument(source)
  const entries = kustomizeOverrides(doc, opts.imageName, opts.applicationPath)
  if (entries.length !== 1) {
    throw new Error(
      `Expected one kustomize image override for ${opts.imageName} in ${opts.applicationPath}, found ${entries.length}`,
    )
  }
  const [entry] = entries
  const prefix = entry.value.slice(0, entry.value.indexOf("=") + 1)
  const pin = `${prefix}${opts.imageName}@${opts.digest}`
  entry.value = pin
  const updated = String(doc)

  const written = kustomizeOverrides(
    YAML.parseDocument(updated),
    opts.imageName,
    opts.applicationPath,
  ).map((item) => item.value)
  if (written.length !== 1 || written[0] !== pin) {
    throw new Error(
      `${opts.applicationPath} would pin ${opts.imageName} as ${
        JSON.stringify(written)
      }, not ${pin}`,
    )
  }
  return updated
}

/**
 * Pin an image by digest in an Argo CD Application's
 * `spec.source.kustomize.images`: for a service whose Kustomize manifests
 * live in its own repository, the pin is kept here in k8s-config instead.
 */
export async function pinArgoKustomizeImageDigest(
  opts: PinArgoKustomizeImageDigestOptions,
): Promise<void> {
  await updateK8sConfigFile({
    path: opts.applicationPath,
    commitMessage: opts.commitMessage,
    update: (source) => pinArgoKustomizeImage(source, opts),
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
