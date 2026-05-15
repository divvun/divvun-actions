import YAML from "yaml"
import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

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

export async function bumpKustomizeImageTag(
  opts: BumpKustomizeImageTagOptions,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "k8s-config-bump-" })
  try {
    const git = (args: string[], cwd: string) =>
      builder.exec("git", args, { cwd })

    await git(
      ["clone", "--depth", "1", K8S_CONFIG_REPO, "k8s-config"],
      tempDir,
    )

    const repoDir = `${tempDir}/k8s-config`
    const manifestPath = `${repoDir}/${opts.kustomizationPath}`
    const source = await Deno.readTextFile(manifestPath)
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

    await Deno.writeTextFile(manifestPath, String(doc))

    const diff = await builder.output("git", [
      "diff",
      "--quiet",
      "--",
      opts.kustomizationPath,
    ], { cwd: repoDir })
    if (diff.status.code === 0) {
      logger.info(
        `${opts.imageName} already at ${opts.tag} in ${opts.kustomizationPath}`,
      )
      return
    }
    if (diff.status.code !== 1) {
      throw new Error(`git diff --quiet failed: ${diff.stderr}`)
    }

    await git(["config", "user.name", COMMIT_AUTHOR_NAME], repoDir)
    await git(["config", "user.email", COMMIT_AUTHOR_EMAIL], repoDir)
    await git(["add", opts.kustomizationPath], repoDir)
    await git(["commit", "-m", opts.commitMessage], repoDir)
    await git(["push", "origin", "HEAD"], repoDir)
  } finally {
    await Deno.remove(tempDir, { recursive: true })
  }
}
