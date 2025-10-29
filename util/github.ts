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
