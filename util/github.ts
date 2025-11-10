import logger from "./log.ts"

export interface GitHubRelease {
  tagName: string
  name: string
  url: string
  publishedAt: string
  isDraft: boolean
  isPrerelease: boolean
  assets: Array<{
    name: string
    url: string
    downloadUrl: string
  }>
}

export class GitHub {
  #repo: string

  constructor(repo: string) {
    this.#repo = repo
  }

  async createRelease(
    tag: string,
    artifacts: string[],
    options: {
      draft?: boolean
      prerelease?: boolean
      latest?: boolean
      verifyTag?: boolean
    } = {},
  ) {
    const {
      draft = false,
      prerelease = false,
      latest = false,
      verifyTag = true,
    } = options

    const args = [
      "release",
      "create",
      tag,
      "--generate-notes",
      `--latest=${latest}`,
      "--repo",
      this.#repo,
      ...artifacts,
    ]

    if (verifyTag) {
      args.splice(3, 0, "--verify-tag")
    }

    if (draft) {
      args.push("--draft")
    }

    if (prerelease) {
      args.push("--prerelease")
    }

    logger.info(
      `Creating GitHub release: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )
    const proc = new Deno.Command("gh", {
      args,
    }).spawn()

    const { code } = await proc.output()
    if (code !== 0) {
      throw new Error(`Failed to create GitHub release: exit code ${code}`)
    }
  }

  async uploadRelease(tag: string, artifacts: string[]) {
    const args = [
      "release",
      "upload",
      tag,
      "--repo",
      this.#repo,
      ...artifacts,
    ]

    logger.info(
      `Uploading to release: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )
    const proc = new Deno.Command("gh", {
      args,
    }).spawn()

    const { code } = await proc.output()
    if (code !== 0) {
      throw new Error(`Failed to upload to release: exit code ${code}`)
    }
  }

  async releaseExists(tag: string): Promise<boolean> {
    const args = ["release", "view", tag, "--repo", this.#repo]

    const proc = new Deno.Command("gh", {
      args,
      stdout: "null",
      stderr: "null",
    }).spawn()

    const { code } = await proc.output()
    return code === 0
  }

  async ensureTagExists(tag: string): Promise<void> {
    logger.debug(`Checking if tag ${tag} exists...`)

    // Check if tag exists locally
    const checkProc = new Deno.Command("git", {
      args: ["rev-parse", "--verify", tag],
      stdout: "null",
      stderr: "null",
    }).spawn()

    const { code: checkCode } = await checkProc.output()

    if (checkCode === 0) {
      logger.debug(`Tag ${tag} already exists`)
      return
    }

    logger.info(`Tag ${tag} does not exist, creating at first commit...`)

    // Get the first commit SHA
    const firstCommitProc = new Deno.Command("git", {
      args: ["rev-list", "--max-parents=0", "HEAD"],
      stdout: "piped",
      stderr: "piped",
    })

    const { code: firstCommitCode, stdout: firstCommitStdout } =
      await firstCommitProc.output()
    if (firstCommitCode !== 0) {
      throw new Error(
        `Failed to get first commit SHA: exit code ${firstCommitCode}`,
      )
    }

    const firstCommitSha = new TextDecoder().decode(firstCommitStdout).trim()
    logger.debug(`First commit SHA: ${firstCommitSha}`)

    // Create the tag at the first commit
    const createTagProc = new Deno.Command("git", {
      args: ["tag", tag, firstCommitSha],
    }).spawn()

    const { code: createTagCode } = await createTagProc.output()
    if (createTagCode !== 0) {
      throw new Error(`Failed to create tag ${tag}: exit code ${createTagCode}`)
    }

    logger.debug(`Created tag ${tag} at ${firstCommitSha}`)

    // Push the tag to origin
    const pushTagProc = new Deno.Command("git", {
      args: ["push", "origin", tag],
    }).spawn()

    const { code: pushTagCode } = await pushTagProc.output()
    if (pushTagCode !== 0) {
      throw new Error(`Failed to push tag ${tag}: exit code ${pushTagCode}`)
    }

    logger.info(`Successfully created and pushed tag ${tag}`)
  }

  async updateRelease(
    tag: string,
    artifacts: string[],
    options: {
      draft?: boolean
      prerelease?: boolean
    } = {},
  ) {
    const { draft = true, prerelease = true } = options

    const exists = await this.releaseExists(tag)

    if (exists) {
      logger.info(`Release ${tag} exists, fetching assets to delete...`)

      const viewArgs = [
        "release",
        "view",
        tag,
        "--repo",
        this.#repo,
        "--json",
        "assets",
      ]

      const viewProc = new Deno.Command("gh", {
        args: viewArgs,
        stdout: "piped",
        stderr: "piped",
      })

      const { code: viewCode, stdout: viewStdout } = await viewProc.output()
      if (viewCode === 0) {
        const releaseData = JSON.parse(new TextDecoder().decode(viewStdout)) as {
          assets: Array<{ name: string }>
        }

        for (const asset of releaseData.assets) {
          logger.info(`Deleting asset ${asset.name} from release ${tag}...`)
          const deleteArgs = [
            "release",
            "delete-asset",
            tag,
            asset.name,
            "--repo",
            this.#repo,
            "--yes",
          ]

          const deleteProc = new Deno.Command("gh", {
            args: deleteArgs,
          }).spawn()

          const { code: deleteCode } = await deleteProc.output()
          if (deleteCode !== 0) {
            logger.warning(
              `Failed to delete asset ${asset.name}: exit code ${deleteCode}`,
            )
          }
        }
      }

      logger.info(`Uploading new artifacts to existing release ${tag}...`)
      await this.uploadRelease(tag, artifacts)
    } else {
      logger.info(
        `Release ${tag} does not exist, creating as draft and prerelease...`,
      )
      await this.ensureTagExists(tag)
      await this.createRelease(tag, artifacts, {
        draft,
        prerelease,
        latest: false,
        verifyTag: true,
      })
    }
  }

  async getLatestRelease(
    pattern: string | RegExp,
    includePrerelease = false,
  ): Promise<GitHubRelease | null> {
    const args = [
      "release",
      "list",
      "--repo",
      this.#repo,
      "--json",
      "tagName,name,url,publishedAt,isDraft,isPrerelease,assets",
    ]

    logger.debug(
      `Fetching GitHub releases: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )

    const proc = new Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
    })

    const { code, stdout, stderr } = await proc.output()
    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr)
      throw new Error(`Failed to fetch GitHub releases: ${errorText}`)
    }

    const releases = JSON.parse(new TextDecoder().decode(stdout)) as Array<{
      tagName: string
      name: string
      url: string
      publishedAt: string
      isDraft: boolean
      isPrerelease: boolean
      assets: Array<{
        name: string
        url: string
        browserDownloadUrl: string
      }>
    }>

    const filteredReleases = releases
      .filter((release) => {
        if (!includePrerelease && release.isPrerelease) {
          return false
        }
        if (release.isDraft) {
          return false
        }

        if (pattern instanceof RegExp) {
          return pattern.test(release.tagName)
        } else {
          return release.tagName.includes(pattern)
        }
      })
      .sort((a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
      )

    if (filteredReleases.length === 0) {
      return null
    }

    const latest = filteredReleases[0]
    return {
      tagName: latest.tagName,
      name: latest.name,
      url: latest.url,
      publishedAt: latest.publishedAt,
      isDraft: latest.isDraft,
      isPrerelease: latest.isPrerelease,
      assets: latest.assets.map((asset) => ({
        name: asset.name,
        url: asset.url,
        downloadUrl: asset.browserDownloadUrl,
      })),
    }
  }

  async downloadReleaseAssets(
    tagName: string,
    assetPattern?: string | RegExp,
    downloadDir = "./downloads",
  ): Promise<string[]> {
    const args = [
      "release",
      "download",
      tagName,
      "--repo",
      this.#repo,
      "--dir",
      downloadDir,
    ]

    if (assetPattern) {
      if (assetPattern instanceof RegExp) {
        args.push("--pattern", assetPattern.source)
      } else {
        args.push("--pattern", assetPattern)
      }
    }

    logger.info(
      `Downloading release assets: gh ${args.map((a) => `"${a}"`).join(" ")}`,
    )

    const proc = new Deno.Command("gh", {
      args,
      stdout: "piped",
      stderr: "piped",
    })

    const { code, stdout, stderr } = await proc.output()
    if (code !== 0) {
      const errorText = new TextDecoder().decode(stderr)
      throw new Error(`Failed to download release assets: ${errorText}`)
    }

    const outputText = new TextDecoder().decode(stdout)
    return outputText
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.trim())
  }
}
