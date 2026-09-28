/**
 * What a CI image records about itself, so a job can say which image and
 * which build of each tool it ran with.
 *
 * A rolling `dev-latest` tool's `--version` does not tell builds apart (every
 * divvunspell build says `1.0.0-beta.13`), but its release asset URL does:
 * `…_1.0.0-dev.20260830T173810Z+build.219.tgz`. The docker tool fragments
 * append one `<name> <url>` line per install at image build time, a final
 * layer stamps when the image last changed, and `divvun-actions ci` prints
 * both.
 */

export const IMAGE_MANIFEST_DIR = "/etc/divvun-actions"
export const INSTALLED_TOOLS_FILE = `${IMAGE_MANIFEST_DIR}/installed-tools`
export const IMAGE_BUILT_FILE = `${IMAGE_MANIFEST_DIR}/image-built`

/**
 * A `&& \`-continued RUN line recording the shell's `$URL` as where `name`
 * was installed from. For the dev-latest fragments, which resolve `$URL`.
 */
export function recordInstalledTool(name: string): string {
  return `    mkdir -p ${IMAGE_MANIFEST_DIR} && echo "${name} $URL" >> ${INSTALLED_TOOLS_FILE} && \\`
}
