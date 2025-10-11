import * as semver from "@std/semver"
import * as toml from "@std/toml"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import logger from "~/util/log.ts"
import { GrammarManifest } from "./bundle.ts"

export type Props = {
  manifestPath: string
  payloadPath: string
  version: string
}

async function loadManifest(manifestPath: string): Promise<GrammarManifest> {
  const manifestString = await Deno.readTextFile(manifestPath)
  const parsed = toml.parse(manifestString) as any
  return {
    name: parsed.name || parsed.grammarname,
    version: parsed.version || parsed.grammarversion,
  }
}

function isPrerelease(version: string): boolean {
  try {
    const parsed = semver.parse(version)
    return parsed.prerelease.length > 0
  } catch {
    return false
  }
}

export default async function grammarDeploy({
  manifestPath,
  payloadPath,
  version,
}: Props) {
  try {
    const manifest = await loadManifest(manifestPath)

    if (!builder.env.repo) {
      throw new Error("No repository information available")
    }

    if (!builder.env.tag) {
      throw new Error("No tag information available")
    }

    const prerelease = isPrerelease(version)

    logger.info(`Deploying grammar checker version ${version}`)
    logger.info(`Pre-release: ${prerelease}`)
    logger.info(`Payload: ${payloadPath}`)

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(builder.env.tag, [payloadPath], false, prerelease)

    logger.info("Grammar checker deployed successfully")
  } catch (error: any) {
    logger.error(error.message)
    Deno.exit(1)
  }
}
