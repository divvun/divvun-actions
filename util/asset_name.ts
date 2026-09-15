/**
 * The one shape a released tool archive is named in:
 *
 *     <name>_<target>_<version>.<ext>
 *     hfst_aarch64-apple-darwin_0.1.0-dev.20260915T115329Z+build.97.tgz
 *
 * Underscores separate the three fields. Target triples and versions never
 * contain one, so a filename splits back into its fields on `_` no matter
 * how many dashes, dots and pluses the fields themselves carry — which is
 * exactly what the old `<name>-<target>-<version>` shape could not do. (A
 * name may itself contain underscores — `libdivvun_runtime` — so parse by
 * anchoring on the known name rather than splitting blind.)
 *
 * Every producer (release pipeline) and consumer (docker tool fragment
 * grepping GitHub release JSON) builds its strings here, so the two sides
 * cannot drift apart. Assets published before this convention carry the
 * dash shape; the matcher helpers accept both separators so a consumer
 * following a rolling tag keeps working across the transition, and can
 * tighten to `_` once every rolling release has been republished. A
 * consumer pinned to an old release keeps that release's literal names
 * until the pin moves.
 *
 * Not this convention: pahkat artifacts (`thfst-tools_1.0.0-alpha.2_linux_amd64.txz`,
 * `<name>_<version>_<platform>`) and static-lib-build's internal caches
 * (`protobuf_<version>_<triple>`), which put the version second and have
 * their own producer/consumer pairs.
 */

/** `<name>_<target>_<version>` — the archive's stem, and the staging
 * directory it unpacks to. */
export function assetStem(
  name: string,
  target: string,
  version: string,
): string {
  return `${name}_${target}_${version}`
}

/** `<name>_<target>_<version>.<ext>` */
export function assetFileName(
  name: string,
  target: string,
  version: string,
  ext: string,
): string {
  return `${assetStem(name, target, version)}.${ext}`
}

/**
 * POSIX-ERE fragment matching any version of `name` for `target` in either
 * separator shape, for `grep -E` over GitHub release JSON — hence `[^"]*`
 * as the version wildcard.
 */
export function assetGrepPattern(
  name: string,
  target: string,
  ext: string,
): string {
  return `${name}[-_]${target}[-_][^"]*\\.${ext}`
}

/**
 * Shell glob matching the unpacked staging directory of any version, either
 * separator shape. POSIX sh bracket classes, so it works in a Dockerfile
 * RUN.
 */
export function assetGlob(name: string, target: string): string {
  return `${name}[-_]${target}[-_]*`
}

/**
 * PowerShell/.NET regex for matching a release asset name on Windows
 * (`$_.name -match ...`), either separator shape, any version.
 */
export function assetPsPattern(
  name: string,
  target: string,
  ext: string,
): string {
  return `^${name}[-_]${target}[-_].+\\.${ext}$`
}
