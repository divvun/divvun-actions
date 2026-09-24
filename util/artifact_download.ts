import * as builder from "~/builder.ts"
import logger from "~/util/log.ts"

/**
 * Buildkite records an artifact's path as the uploading agent wrote it, so the
 * same binary can be stored as `target/.../hfst.exe` or `target\...\hfst.exe`
 * depending on which agent produced it. Pinning either shape breaks the other:
 * a pipeline that pinned backslashes for Windows found nothing once its
 * artifacts were stored forward-slashed.
 *
 * Try the canonical forward-slash path, fall back to backslashes.
 */
export async function downloadBinary(artifactPath: string, outputDir: string) {
  try {
    await builder.downloadArtifacts(artifactPath, outputDir)
  } catch (err) {
    const alt = artifactPath.replaceAll("/", "\\")
    if (alt === artifactPath) throw err
    logger.warning(`No artifact at ${artifactPath}; retrying as ${alt}`)
    await builder.downloadArtifacts(alt, outputDir)
  }
}

/** Shell form of [downloadBinary], for steps that run buildkite-agent directly. */
export function downloadBinaryCmd(artifactPath: string): string {
  const alt = artifactPath.replaceAll("/", "\\")
  const primary = `buildkite-agent artifact download '${artifactPath}' .`
  if (alt === artifactPath) return primary
  return `${primary} || buildkite-agent artifact download '${alt}' .`
}
