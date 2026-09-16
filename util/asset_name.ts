/**
 * The one shape a released tool archive is named in:
 *
 *     <name>_<target>_<version>.<ext>
 *     hfst_aarch64-apple-darwin_0.1.0-dev.20260915T115329Z+build.97.tgz
 *
 * Underscores separate the three fields. Target underscores are normalized to
 * hyphens (x86_64 becomes x86-64), so a filename splits back into its fields on `_` no matter
 * how many dashes, dots and pluses the fields themselves carry — which is
 * exactly what the old `<name>-<target>-<version>` shape could not do. (A
 * name may itself contain underscores — `libdivvun_runtime` — so parse by
 * anchoring on the known name rather than splitting blind.)
 *
 * Every producer (release pipeline) and consumer (docker tool fragment
 * grepping GitHub release JSON) builds its strings here, so the two sides
 * cannot drift apart. Assets published before this convention carry the
 * dash shape and x86_64 spelling; the matcher helpers accept both so a consumer
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

/** Normalize target spelling for release names, without changing build triples. */
export function assetTarget(target: string): string {
  return target.replaceAll("_", "-")
}

/** Shared regex/glob syntax accepting canonical and historical target separators. */
function compatibleTarget(target: string): string {
  return assetTarget(target).replaceAll("-", "[-_]")
}

/** `<name>_<target>_<version>` — the archive's stem, and the staging
 * directory it unpacks to. */
export function assetStem(
  name: string,
  target: string,
  version: string,
): string {
  return `${name}_${assetTarget(target)}_${version}`
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
  return `${name}[-_]${compatibleTarget(target)}[-_][^"]*\\.${ext}`
}

/**
 * Shell glob matching the unpacked staging directory of any version, either
 * separator shape. POSIX sh bracket classes, so it works in a Dockerfile
 * RUN. Not usable with `gh` — see [assetGhPattern].
 */
export function assetGlob(name: string, target: string): string {
  return `${name}[-_]${compatibleTarget(target)}[-_]*`
}

/**
 * Glob for `gh release download --pattern`, which matches with Go's
 * `filepath.Match`. That treats a literal `-` leading a bracket expression as
 * ErrBadPattern and reports it as "no assets match the file pattern", so
 * [assetGlob]'s `[-_]` classes match *nothing* there — for every target, not
 * just the one being looked for. Verified against the live API: `BLAKE3SUM[S_]`
 * matches, `BLAKE3SUM[-S]` does not.
 *
 * `?` stands in for each separator instead. It matches any single character,
 * so it accepts both shapes without a bracket expression.
 */
export function assetGhPattern(
  name: string,
  target: string,
  ext: string,
): string {
  return `${name}?${assetTarget(target).replaceAll("-", "?")}?*.${ext}`
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
  return `^${name}[-_]${compatibleTarget(target)}[-_].+\\.${ext}$`
}
