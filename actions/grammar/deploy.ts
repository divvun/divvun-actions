import * as semver from "@std/semver"
import * as builder from "~/builder.ts"
import { GitHub } from "~/util/github.ts"
import { createSignedChecksums } from "~/util/hash.ts"
import logger from "~/util/log.ts"

export type Props = {
  payloadPath: string
  version: string
}

function isPrerelease(version: string): boolean {
  try {
    const parsed = semver.parse(version)
    return (parsed.prerelease?.length ?? 0) > 0
  } catch {
    return false
  }
}

export default async function grammarDeploy({
  payloadPath,
  version,
}: Props) {
  try {
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

    const { checksumFile, signatureFile } = await createSignedChecksums(
      [payloadPath],
      await builder.secrets(),
    )

    const gh = new GitHub(builder.env.repo)
    await gh.createRelease(
      builder.env.tag,
      [payloadPath, checksumFile, signatureFile],
      { prerelease },
    )

    logger.info("Grammar checker deployed successfully")
  } catch (error: any) {
    logger.error(error.message)
    Deno.exit(1)
  }
}
