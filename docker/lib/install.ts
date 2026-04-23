import type { RenderCtx } from "./platform.ts"

export function run(ctx: RenderCtx, lines: string[]): string {
  const sep = ctx.shell === "pwsh" ? " ; \\\n    " : " && \\\n    "
  return `RUN ${lines.join(sep)}`
}

export type DownloadBinaryOpts = {
  url: string
  dest: string
  chmod?: boolean
}

/** Download a single binary straight to a path (e.g. b3sum). */
export function downloadBinary(
  ctx: RenderCtx,
  opts: DownloadBinaryOpts,
): string[] {
  if (ctx.platform === "windows") {
    return [
      `Invoke-WebRequest -Uri "${opts.url}" -OutFile "${opts.dest}"`,
    ]
  }
  const lines = [`curl -fsSL "${opts.url}" -o ${opts.dest}`]
  if (opts.chmod) lines.push(`chmod +x ${opts.dest}`)
  return lines
}

export type DownloadAndExtractOpts = {
  url: string
  /** Extract contents into this dir. Mutually exclusive with `pickBinary`. */
  extractTo?: string
  /**
   * Extract to a tempdir, move a single named file into /usr/local/bin (or C:\bin),
   * then clean up the tempdir.
   */
  pickBinary?: {
    /** Path within the extracted tree, relative to the extraction root. */
    from: string
    /** Destination file (absolute). */
    to: string
  }
  /** `tar.gz`, `tgz`, `zip`, `txz`, `tar.xz`, `deb`. Defaults based on URL suffix. */
  kind?: "tar.gz" | "tgz" | "zip" | "txz" | "tar.xz" | "deb"
}

function inferKind(url: string): DownloadAndExtractOpts["kind"] {
  if (url.endsWith(".tar.gz") || url.endsWith(".tgz")) return "tar.gz"
  if (url.endsWith(".zip")) return "zip"
  if (url.endsWith(".txz")) return "txz"
  if (url.endsWith(".tar.xz")) return "tar.xz"
  if (url.endsWith(".deb")) return "deb"
  throw new Error(`Cannot infer archive kind from URL: ${url}`)
}

/**
 * Download + extract, linux variants. Returns shell lines (no RUN prefix).
 */
export function downloadAndExtractLinux(
  ctx: RenderCtx,
  opts: DownloadAndExtractOpts,
): string[] {
  if (ctx.platform === "windows") {
    throw new Error("downloadAndExtractLinux called on windows")
  }
  const kind = opts.kind ?? inferKind(opts.url)
  const archiveName = {
    "tar.gz": "archive.tar.gz",
    "tgz": "archive.tgz",
    "zip": "archive.zip",
    "txz": "archive.txz",
    "tar.xz": "archive.tar.xz",
    "deb": "archive.deb",
  }[kind]

  const lines: string[] = [`curl -fsSL "${opts.url}" -o ${archiveName}`]

  if (opts.pickBinary) {
    const tmp = "/tmp/_extract"
    lines.push(`mkdir -p ${tmp}`)
    lines.push(extractCmd(kind, archiveName, tmp))
    lines.push(`mv ${tmp}/${opts.pickBinary.from} ${opts.pickBinary.to}`)
    lines.push(`rm -rf ${archiveName} ${tmp}`)
    return lines
  }

  if (!opts.extractTo) {
    throw new Error("downloadAndExtract requires extractTo or pickBinary")
  }
  lines.push(`mkdir -p ${opts.extractTo}`)
  lines.push(extractCmd(kind, archiveName, opts.extractTo))
  lines.push(`rm -f ${archiveName}`)
  return lines
}

function extractCmd(
  kind: NonNullable<DownloadAndExtractOpts["kind"]>,
  archive: string,
  dest: string,
): string {
  switch (kind) {
    case "tar.gz":
    case "tgz":
      return `tar -xzf ${archive} -C ${dest}`
    case "tar.xz":
      return `tar -xf ${archive} -C ${dest}`
    case "txz":
      return `bsdtar -xf ${archive} -C ${dest}`
    case "zip":
      return `unzip -q ${archive} -d ${dest}`
    case "deb":
      return `dpkg -i ${archive}`
  }
}

/**
 * Emit a single-RUN apt install of a batched set of packages.
 * Includes apt-get update, DEBIAN_FRONTEND, and list cleanup.
 */
export function aptInstall(packages: string[]): string {
  const pkgLines = packages.map((p) => `    ${p}`).join(" \\\n")
  return [
    `RUN apt-get update && \\`,
    `    DEBIAN_FRONTEND=noninteractive apt-get install -y \\`,
    pkgLines + ` && \\`,
    `    rm -rf /var/lib/apt/lists/* && apt-get clean`,
  ].join("\n")
}

/** Emit a single-RUN apk add of packages. */
export function apkInstall(packages: string[]): string {
  const pkgLines = packages.map((p) => `    ${p}`).join(" \\\n")
  return [
    `RUN apk update && apk upgrade && apk add --no-cache \\`,
    pkgLines,
  ].join("\n")
}
