import * as fs from "@std/fs"
import * as path from "@std/path"
import * as builder from "~/builder.ts"
import { BuildkitePipeline, CommandStep } from "~/builder/pipeline.ts"
import * as targetModule from "~/target.ts"
import { globOneFile } from "~/util/glob.ts"
import { bumpKustomizeImageTag } from "~/util/k8s-config.ts"
import logger from "~/util/log.ts"

const IMAGE = "ghcr.io/divvun/teaksta"
const KUSTOMIZATION_PATH = "kustomize/teaksta/kustomization.yaml"

/**
 * The two model artifacts teaksta's model-gated suites need, both published by
 * giellalt/lang-sme's own pipeline:
 *
 * - the divvun-runtime bundle exposing the `tokenize`/`analyze`/`sentences`
 *   pipelines, from the `teaksta-bundle` build (see
 *   actions/lang/build-teaksta-bundle.ts);
 * - the normative generator, which ships inside the speller build's `fst-sme`
 *   package as `generator-gt-norm.hfstol` — the same asset pipelines/dict
 *   reads for its own generator.
 */
const LANG_SME_REPO = "giellalt/lang-sme"
const BUNDLE_RELEASE_TAG = "teaksta-sme/dev-latest"
const BUNDLE_ASSET_PATTERN = "teaksta-sme_*_noarch-all.drb"
const GENERATOR_RELEASE_TAG = "speller-sme/dev-latest"
const GENERATOR_ASSET_PATTERN = "fst-sme_*_noarch-all.pkt.tar.zst"
const GENERATOR_FILE = "generator-gt-norm.hfstol"

function command(input: CommandStep): CommandStep {
  return {
    ...input,
    plugins: [
      ...(input.plugins ?? []),
      `ssh://git@github.com/divvun/divvun-actions.git#${targetModule.gitHash}`,
    ],
  }
}

/**
 * Cargo target cache, keyed on Cargo.lock. Only the steps that actually run
 * cargo on the agent carry it: the deploy step builds inside Docker (which has
 * its own layer cache and never sees the host `target/`), and the manifest bump
 * touches no Rust at all. Same split as pipelines/gut.ts.
 */
function cachePlugin(keyExtra: string) {
  return {
    "cache#v1.7.0": {
      manifest: "Cargo.lock",
      path: "target",
      restore: "file",
      save: "file",
      "key-extra": keyExtra,
    },
  }
}

export function pipelineTeaksta(): BuildkitePipeline {
  return {
    steps: [
      command({
        key: "check",
        label: "Check",
        command: "divvun-actions run teaksta-check",
        agents: { queue: "linux" },
        plugins: [cachePlugin("check")],
      }),
      command({
        key: "models",
        // EXPECTED TO SOFT-FAIL until giellalt/lang-sme has published its
        // first teaksta-sme/dev-latest release: the bundle asset this step
        // downloads only starts existing once the lang-sme side of this change
        // (actions/lang/build-teaksta-bundle.ts) lands AND
        // `.build-config.yml`'s `build.teaksta-bundle` is flipped to true in
        // that repo. Until then the download fails, the step goes red-but-soft,
        // and nothing downstream is blocked. Drop the soft_fail once the
        // release exists and this step has been seen green.
        label: "Test with models (soft-fail until lang-sme publishes)",
        command: "divvun-actions run teaksta-models",
        agents: { queue: "linux", size: "large" },
        branches: "main",
        depends_on: ["check"],
        soft_fail: true,
        plugins: [cachePlugin("models")],
      }),
      command({
        key: "build-push",
        label: "Build & Push",
        command: "divvun-actions run teaksta-deploy",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: ["check"],
      }),
      command({
        label: "Bump k8s app manifest",
        command: "divvun-actions run teaksta-bump-manifest",
        agents: { queue: "linux" },
        branches: "main",
        depends_on: ["build-push"],
      }),
    ],
  }
}

export async function runTeakstaCheck() {
  await builder.exec("cargo", ["fmt", "--check"])
  await builder.exec("cargo", ["check", "--workspace"])
  // The workspace's tests are model-free by design: the suites that exercise
  // the real models report themselves skipped when TEAKSTA_BUNDLE /
  // TEAKSTA_GENERATOR are unset, so a plain run is green here and the `models`
  // step below is what actually puts them through their paces.
  await builder.exec("cargo", ["test", "--workspace"])

  // teaksta-web is a Dioxus app compiled to wasm; `cargo check --workspace`
  // above only type-checks it for the host.
  await builder.exec("rustup", ["target", "add", "wasm32-unknown-unknown"])
  await builder.exec("cargo", [
    "check",
    "-p",
    "teaksta-web",
    "--target",
    "wasm32-unknown-unknown",
  ])
}

/**
 * Where the fs-cache plugin keeps its folder on the agents
 * (`/var/cache/buildkite`, set in docker/images/linux.ts). Mirrors the fallback
 * in actions/lang/common.ts so a local run still has somewhere to put things.
 */
function fsCacheDir(): string {
  return Deno.env.get("BUILDKITE_PLUGIN_FS_CACHE_FOLDER") ??
    path.join(Deno.env.get("HOME") ?? "/tmp", ".cache", "divvun-actions")
}

async function shortHash(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  )
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)
}

/** `gh release view --json assets` shape: `url` is the browser download URL. */
type ReleaseAsset = {
  name: string
  url: string
  /**
   * What the pattern's `*` matched — the version segment of the filename, e.g.
   * `4.5.2-dev.20260911T084217Z+build.1664`. This is the identity of the model
   * the release is currently serving: the rolling tag has no version in it,
   * the asset name does.
   */
  version: string
}

/**
 * The one asset on `tag` whose name matches `pattern`.
 *
 * Both releases are rolling (`dev-latest`), so the tag alone identifies
 * nothing — but the asset *filename* carries the dev version
 * (`teaksta-sme_1.2.3-dev.20260101T000000Z+build.42_noarch-all.drb`), which
 * makes the download URL a content-identifying cache key and the captured
 * version segment the exact thing the image build has to be told.
 */
async function releaseAsset(
  repo: string,
  tag: string,
  pattern: string,
): Promise<ReleaseAsset> {
  const [prefix, suffix, ...rest] = pattern.split("*")
  if (suffix === undefined || rest.length > 0) {
    throw new Error(
      `Asset pattern needs exactly one '*' (the version segment): ${pattern}`,
    )
  }
  const matcher = new RegExp(
    `^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`,
  )

  const result = await builder.output("gh", [
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "assets",
  ])
  if (result.status.code !== 0) {
    throw new Error(
      `gh release view ${tag} --repo ${repo} failed: ${result.stderr.trim()}`,
    )
  }

  const { assets } = JSON.parse(result.stdout) as {
    assets: { name: string; url: string }[]
  }
  const matches = assets.flatMap((asset) => {
    const m = matcher.exec(asset.name)
    return m ? [{ ...asset, version: m[1] }] : []
  })
  if (matches.length === 0) {
    throw new Error(
      `No asset matching ${pattern} on ${repo}@${tag} (saw: ${
        assets.map((a) => a.name).join(", ") || "no assets"
      })`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} assets match ${pattern} on ${repo}@${tag}: ${
        matches.map((a) => a.name).join(", ")
      }`,
    )
  }
  return matches[0]
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Download a release asset into the agent's fs-cache, keyed on its URL, and
 * return the absolute path to it. A second build of the same lang-sme release
 * re-uses the file; a new dev release changes the filename, so it changes the
 * key and is fetched fresh.
 */
async function cachedReleaseAsset(opts: {
  repo: string
  tag: string
  pattern: string
  label: string
}): Promise<string> {
  const asset = await releaseAsset(opts.repo, opts.tag, opts.pattern)
  const cacheDir = path.join(
    fsCacheDir(),
    "teaksta-models",
    await shortHash(asset.url),
  )
  const assetPath = path.join(cacheDir, asset.name)

  if (await fs.exists(assetPath)) {
    logger.info(`Cache hit for ${opts.label}: ${assetPath}`)
    return assetPath
  }

  logger.info(`Downloading ${opts.label} from ${opts.repo}@${opts.tag}`)
  await fs.ensureDir(cacheDir)
  await builder.exec("gh", [
    "release",
    "download",
    opts.tag,
    "--repo",
    opts.repo,
    "--pattern",
    opts.pattern,
    "--dir",
    cacheDir,
    "--clobber",
  ])

  if (!(await fs.exists(assetPath))) {
    throw new Error(`${asset.name} not found in ${cacheDir} after download`)
  }
  return assetPath
}

/**
 * Drop every cached model directory except the ones this build is using. The
 * lang-sme dev releases move often and each bundle is hundreds of megabytes,
 * so without this the agents' fs-cache grows without bound.
 */
async function pruneModelCache(keep: string[]) {
  const root = path.join(fsCacheDir(), "teaksta-models")
  if (!(await fs.exists(root))) {
    return
  }
  const kept = new Set(keep.map((p) => path.basename(p)))
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || kept.has(entry.name)) {
      continue
    }
    logger.info(`Pruning stale model cache entry ${entry.name}`)
    try {
      await Deno.remove(path.join(root, entry.name), { recursive: true })
    } catch (e) {
      logger.warning(`Could not prune ${entry.name}: ${e}`)
    }
  }
}

export async function runTeakstaModels() {
  const bundlePath = await cachedReleaseAsset({
    repo: LANG_SME_REPO,
    tag: BUNDLE_RELEASE_TAG,
    pattern: BUNDLE_ASSET_PATTERN,
    label: "teaksta bundle",
  })

  const fstArchive = await cachedReleaseAsset({
    repo: LANG_SME_REPO,
    tag: GENERATOR_RELEASE_TAG,
    pattern: GENERATOR_ASSET_PATTERN,
    label: "sme FST package",
  })

  // Extract beside the archive, inside the same URL-keyed cache directory, so
  // the extraction is cached with the download it came from.
  const extractDir = path.join(path.dirname(fstArchive), "fst-extract")
  const generatorPath = path.join(extractDir, GENERATOR_FILE)
  if (!(await fs.exists(generatorPath))) {
    await fs.ensureDir(extractDir)
    await builder.exec("tar", ["--zstd", "-xf", fstArchive, "-C", extractDir])
  }
  if (!(await fs.exists(generatorPath))) {
    const found = await globOneFile(`**/${GENERATOR_FILE}`, {
      root: extractDir,
    })
    if (!found) {
      throw new Error(`${GENERATOR_FILE} not found in ${fstArchive}`)
    }
    throw new Error(
      `${GENERATOR_FILE} was not at the expected ${generatorPath} (found ${found})`,
    )
  }

  await pruneModelCache([
    path.dirname(bundlePath),
    path.dirname(fstArchive),
  ])

  logger.info(`TEAKSTA_BUNDLE=${bundlePath}`)
  logger.info(`TEAKSTA_GENERATOR=${generatorPath}`)

  await builder.exec("cargo", ["test", "--workspace"], {
    env: {
      TEAKSTA_BUNDLE: bundlePath,
      TEAKSTA_GENERATOR: generatorPath,
    },
  })
}

export async function runTeakstaDeploy() {
  const tag = `sha-${builder.env.commit}`

  // The image carries its models, and the Dockerfile refuses to build without
  // being told which: the version arguments have no defaults, so a bare
  // `docker build` exits with guidance rather than producing a model-less
  // image. Resolve the same two assets the `models` step tests against, so the
  // image that ships is built from the models that were exercised.
  const bundle = await releaseAsset(
    LANG_SME_REPO,
    BUNDLE_RELEASE_TAG,
    BUNDLE_ASSET_PATTERN,
  ).catch((e) => {
    // The one failure worth naming: the image cannot be built at all until
    // giellalt/lang-sme has published its first teaksta bundle.
    throw new Error(
      `Cannot resolve the teaksta bundle, so the image cannot be built — it ` +
        `carries its models. Waiting on the first ${BUNDLE_RELEASE_TAG} ` +
        `release from ${LANG_SME_REPO}. ${e}`,
    )
  })
  const fst = await releaseAsset(
    LANG_SME_REPO,
    GENERATOR_RELEASE_TAG,
    GENERATOR_ASSET_PATTERN,
  )

  logger.info(`Building against bundle ${bundle.version} (${bundle.name})`)
  logger.info(`Building against FST ${fst.version} (${fst.name})`)

  // The root Dockerfile builds the whole workspace, wasm bundle included, and
  // fetches the two models by exact asset version.
  await builder.exec("docker", [
    "build",
    "--build-arg",
    `TEAKSTA_BUNDLE_VERSION=${bundle.version}`,
    "--build-arg",
    `TEAKSTA_FST_VERSION=${fst.version}`,
    // The Dockerfile otherwise derives each release tag from its version
    // (`teaksta-sme/v<version without build metadata>`), which is right for a
    // real release and wrong for these two: both assets currently hang off a
    // rolling `dev-latest` tag, whose name carries no version at all. Naming
    // the tags explicitly is needed only for as long as that stays true — once
    // this pipeline builds against cut `teaksta-sme/vX.Y.Z` and
    // `speller-sme/vX.Y.Z` releases, both _TAG arguments can go.
    "--build-arg",
    `TEAKSTA_BUNDLE_TAG=${BUNDLE_RELEASE_TAG}`,
    "--build-arg",
    `TEAKSTA_FST_TAG=${GENERATOR_RELEASE_TAG}`,
    "-t",
    `${IMAGE}:latest`,
    "-t",
    `${IMAGE}:${tag}`,
    ".",
  ], {
    // The Dockerfile is BuildKit-only: the `# syntax=` directive, the
    // `--mount=type=cache` mounts over the cargo registry and target dir, and
    // the `models` named build context are all BuildKit features. It is the
    // default from Docker 23 and the agent image installs
    // docker-buildx-plugin, so this is an assertion rather than a fix.
    env: { DOCKER_BUILDKIT: "1" },
  })

  await builder.group("Pushing image", async () => {
    await Promise.all([
      builder.exec("docker", ["push", `${IMAGE}:latest`]),
      builder.exec("docker", ["push", `${IMAGE}:${tag}`]),
    ])
  })

  await builder.setMetadata("teaksta-tag", tag)
}

export async function runTeakstaBumpManifest() {
  const tag = (await builder.metadata("teaksta-tag")).trim()
  if (tag.length === 0) {
    throw new Error("Buildkite metadata teaksta-tag was empty")
  }

  await bumpKustomizeImageTag({
    imageName: IMAGE,
    tag,
    kustomizationPath: KUSTOMIZATION_PATH,
    commitMessage: `Update teaksta image to ${tag}`,
  })
}
