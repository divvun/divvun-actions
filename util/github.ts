import logger from "./log.ts"

export class GitHub {
  #repo: string

  constructor(repo: string) {
    this.#repo = repo
  }

  async createRelease(
    tag: string,
    artifacts: string[],
    draft = false,
    prerelease = false,
  ) {
    const args = [
      "release",
      "create",
      tag,
      "--verify-tag",
      "--generate-notes",
      "--repo",
      this.#repo,
      ...artifacts,
    ]

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
}
