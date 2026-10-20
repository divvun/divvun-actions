// Fluent TOML builder for outto installer manifests.
//
// outto is a Rust-based installer tool. Each target platform has its own
// schema (Windows: registry/services/shortcuts; macOS: launchd/plist/symlinks).
// This module emits TOML compatible with both, but exposes a single TS surface
// so the consumer doesn't have to hand-write platform-specific config.
//
// See /Users/brendan/git/necessary/divvun/outto for the schema definitions.

import * as path from "@std/path"
import * as toml from "@std/toml"

export type OuttoPlatform = "windows" | "macos"

export type Overwrite =
  | "always"
  | "never"
  | "if_newer"
  | "prompt"
  | "ignore_version"
  | "replace_same_version"
  | "prompt_if_older"

export type RunPhase =
  | "before_install"
  | "after_install"
  | "before_uninstall"
  | "after_uninstall"

type FileEntry = {
  source: string
  dest: string
  overwrite?: Overwrite
  arch?: "x64" | "x86" | "arm64" | "x86_64" | "universal" | "any"
  /** macOS only: use ditto so .app bundles preserve xattrs/symlinks/signatures. */
  bundle?: boolean
  dest_name?: string
  excludes?: string[]
  component?: string
}

type DirEntry = {
  path: string
  permissions?: string | Array<{ identity: string; access: string }>
  owner?: string
  preserve_on_uninstall?: boolean
  component?: string
}

type SymlinkEntry = {
  target: string
  link: string
  overwrite?: Overwrite
}

type RunEntry = {
  phase: RunPhase
  command: string
  arguments?: string
  wait?: boolean
  show?: "normal" | "hidden" | "minimized" | "maximized"
  working_dir?: string
  component?: string
  /** Windows: run as the signed-in desktop user, not the elevated installer. */
  run_as_original_user?: boolean
}

type ShortcutEntry = {
  name: string
  target: string
  location: "start_menu" | "desktop" | "startup"
  icon?: string
  working_dir?: string
  arguments?: string
  description?: string
  subfolder?: string
}

/** Windows: a COM server, registered with regsvr32 and unregistered again. */
type ComEntry = {
  file: string
  action: "regserver" | "typelib"
  arch?: "x64" | "x86" | "arm64"
  /**
   * Which regsvr32 registers it: `native`, System32's (the default), or
   * `x86`, SysWOW64's on 64-bit Windows.
   */
  host?: "native" | "x86"
}

/** Windows: the uninstaller refuses while a key like `registry_key` exists. */
type UninstallRefusal = {
  /** `HKLM\...`; a `*` segment matches any one subkey. */
  registry_key: string
  message?: string
}

/** Windows: a registry value naming the installed version. */
type InstalledVersion = {
  registry_key: string
  /** The value's name; the default value when absent. */
  value?: string
  /** `parent_dir_name`: the value is a path inside a version directory. */
  from?: "value" | "parent_dir_name"
}

type RegistryValue = {
  name: string
  type:
    | "string"
    | "dword"
    | "qword"
    | "expand_string"
    | "multi_string"
    | "binary"
  data: string | number | boolean | string[]
}

type RegistryEntry = {
  root: "hklm" | "hkcu" | "hkcr"
  key: string
  values?: RegistryValue[]
  uninstall?: "remove_key" | "remove_values" | "nothing"
}

type PlistValue = {
  key: string
  type: "string" | "integer" | "real" | "bool" | "data" | "array" | "dict"
  data: unknown
}

type PlistEntry = {
  path: string
  values?: PlistValue[]
  uninstall?: "remove_file" | "remove_keys" | "nothing"
}

type LaunchdEntry = {
  label: string
  scope?: "agent" | "daemon"
  program: string
  program_arguments?: string[]
  run_at_load?: boolean
  keep_alive?: boolean
  start_interval?: number
}

type PackageMeta = {
  id?: string
  name?: string
  version?: string
  publisher?: string
  url?: string
  support_url?: string
  license_file?: string
  default_dir?: string
  /** Windows only. */
  architecture?: "x64" | "x86" | "arm64" | "any"
  /** Windows only. */
  privileges?: "admin" | "user" | "auto"
  /** Windows only. */
  disable_dir_page?: boolean
  /** Windows only: the AppId of the Inno Setup installer this replaces. */
  legacy_inno_app_id?: string
  /** Windows only. */
  legacy_inno_mode?: "uninstall" | "adopt"
  /** macOS only. */
  min_macos_version?: string
  /** Windows only. */
  min_version?: string
  depends_on?: string[]
}

type ManifestData = {
  reboot?: { restart_manager: boolean }
  package: PackageMeta
  privileges?: { required?: "user" | "admin" | "auto"; auto_elevate?: boolean }
  upgrade?: {
    policy?: "overwrite" | "side_by_side" | "fail"
    preserve?: string[]
    downgrade?: "allow" | "refuse"
    installed_version?: InstalledVersion
    prune?: string[]
  }
  uninstall?: {
    remove_app_dir?: boolean
    extra_dirs?: string[]
    extra_files?: string[]
    refuse_while?: UninstallRefusal[]
  }
  logging?: { enabled?: boolean; path?: string }
  install_cleanup?: {
    uninstall_ids?: string[]
    delete_paths?: string[]
  }
  files: FileEntry[]
  dirs: DirEntry[]
  symlinks: SymlinkEntry[]
  run: RunEntry[]
  shortcuts: ShortcutEntry[]
  registry: RegistryEntry[]
  com: ComEntry[]
  plist: PlistEntry[]
  launchd: LaunchdEntry[]
}

export class OuttoBuilder {
  #cwd: string
  #platform: OuttoPlatform
  #data: ManifestData = {
    package: {},
    files: [],
    dirs: [],
    symlinks: [],
    run: [],
    shortcuts: [],
    registry: [],
    com: [],
    plist: [],
    launchd: [],
  }

  constructor(cwd: string, platform: OuttoPlatform) {
    this.#cwd = cwd
    this.#platform = platform
  }

  // ── package metadata ────────────────────────────────────────────────────

  id(value: string): this {
    this.#data.package.id = value
    return this
  }

  name(value: string): this {
    this.#data.package.name = value
    return this
  }

  version(value: string): this {
    this.#data.package.version = value
    return this
  }

  publisher(value: string): this {
    this.#data.package.publisher = value
    return this
  }

  url(value: string): this {
    this.#data.package.url = value
    return this
  }

  supportUrl(value: string): this {
    this.#data.package.support_url = value
    return this
  }

  defaultDir(value: string): this {
    this.#data.package.default_dir = value
    return this
  }

  licenseFile(value: string): this {
    this.#data.package.license_file = value
    return this
  }

  // Windows-only
  architecture(value: "x64" | "x86" | "arm64" | "any"): this {
    this.#requirePlatform("windows", "architecture")
    this.#data.package.architecture = value
    return this
  }

  /** Windows: install into `default_dir` without offering to change it. */
  disableDirPage(): this {
    this.#requirePlatform("windows", "disableDirPage")
    this.#data.package.disable_dir_page = true
    return this
  }

  /**
   * Windows: replace the Inno Setup install with AppId `guid` (no braces),
   * running its uninstaller or, with `adopt`, taking it over without.
   */
  legacyInnoAppId(
    guid: string,
    mode: "uninstall" | "adopt" = "uninstall",
  ): this {
    this.#requirePlatform("windows", "legacyInnoAppId")
    this.#data.package.legacy_inno_app_id = guid
    this.#data.package.legacy_inno_mode = mode
    return this
  }

  privileges(value: "admin" | "user" | "auto"): this {
    if (this.#platform === "windows") {
      this.#data.package.privileges = value
    } else {
      this.#data.privileges = { ...this.#data.privileges, required: value }
    }
    return this
  }

  autoElevate(value: boolean): this {
    this.#requirePlatform("macos", "autoElevate")
    this.#data.privileges = { ...this.#data.privileges, auto_elevate: value }
    return this
  }

  minMacosVersion(value: string): this {
    this.#requirePlatform("macos", "minMacosVersion")
    this.#data.package.min_macos_version = value
    return this
  }

  /** Windows: whether outto may close applications holding installed files. */
  restartManager(enabled: boolean): this {
    this.#requirePlatform("windows", "restartManager")
    this.#data.reboot = { restart_manager: enabled }
    return this
  }

  // ── lifecycle policies ──────────────────────────────────────────────────

  upgradePolicy(policy: "overwrite" | "side_by_side" | "fail"): this {
    this.#data.upgrade = { ...this.#data.upgrade, policy }
    return this
  }

  preserveOnUpgrade(globs: string[]): this {
    this.#data.upgrade = { ...this.#data.upgrade, preserve: globs }
    return this
  }

  /**
   * Refuse to install over a newer version: the installed one that
   * `installedVersion` names, or else the existing install's.
   */
  refuseDowngrade(installedVersion?: InstalledVersion): this {
    this.#data.upgrade = {
      ...this.#data.upgrade,
      downgrade: "refuse",
      ...(installedVersion ? { installed_version: installedVersion } : {}),
    }
    return this
  }

  /**
   * After a successful install, remove everything in `dirs` that it did not
   * install, such as earlier versions' directories.
   */
  pruneOnInstall(dirs: string[]): this {
    this.#data.upgrade = { ...this.#data.upgrade, prune: dirs }
    return this
  }

  /** Windows: refuse to uninstall while `refusal` holds. */
  refuseUninstallWhile(refusal: UninstallRefusal): this {
    this.#requirePlatform("windows", "refuseUninstallWhile")
    this.#data.uninstall = {
      ...this.#data.uninstall,
      refuse_while: [...this.#data.uninstall?.refuse_while ?? [], refusal],
    }
    return this
  }

  removeAppDirOnUninstall(value = true): this {
    this.#data.uninstall = { ...this.#data.uninstall, remove_app_dir: value }
    return this
  }

  uninstallLegacyIds(ids: string[]): this {
    this.#data.install_cleanup = {
      ...this.#data.install_cleanup,
      uninstall_ids: ids,
    }
    return this
  }

  // ── files / dirs / symlinks ─────────────────────────────────────────────

  /**
   * Add a file or glob to be installed.
   *
   * `source` is relative to the configured `cwd` (the staging directory the
   * caller hands to outto via `--source`). Absolute paths are normalised to
   * relative against `cwd`.
   */
  file(opts: FileEntry): this {
    const source = path.isAbsolute(opts.source)
      ? path.relative(this.#cwd, opts.source)
      : opts.source
    this.#data.files.push({ ...opts, source })
    return this
  }

  dir(opts: DirEntry): this {
    this.#data.dirs.push(opts)
    return this
  }

  symlink(opts: SymlinkEntry): this {
    this.#requirePlatform("macos", "symlink")
    this.#data.symlinks.push(opts)
    return this
  }

  // ── run hooks ───────────────────────────────────────────────────────────

  run(entry: RunEntry): this {
    this.#data.run.push(entry)
    return this
  }

  // ── windows-only sections ───────────────────────────────────────────────

  shortcut(opts: ShortcutEntry): this {
    this.#requirePlatform("windows", "shortcut")
    this.#data.shortcuts.push(opts)
    return this
  }

  registry(entry: RegistryEntry): this {
    this.#requirePlatform("windows", "registry")
    this.#data.registry.push(entry)
    return this
  }

  /** Registered in order, after the files; unregistered in reverse. */
  com(entry: ComEntry): this {
    this.#requirePlatform("windows", "com")
    this.#data.com.push(entry)
    return this
  }

  // ── macos-only sections ─────────────────────────────────────────────────

  plist(entry: PlistEntry): this {
    this.#requirePlatform("macos", "plist")
    this.#data.plist.push(entry)
    return this
  }

  launchd(entry: LaunchdEntry): this {
    this.#requirePlatform("macos", "launchd")
    this.#data.launchd.push(entry)
    return this
  }

  // ── output ──────────────────────────────────────────────────────────────

  build(): string {
    const required = ["id", "name", "version", "default_dir"] as const
    for (const k of required) {
      if (this.#data.package[k] == null) {
        throw new Error(`OuttoBuilder: missing required package.${k}`)
      }
    }

    const output: Record<string, unknown> = {
      package: this.#data.package,
    }
    if (this.#data.reboot) output.reboot = this.#data.reboot
    if (this.#data.privileges) output.privileges = this.#data.privileges
    if (this.#data.upgrade) output.upgrade = this.#data.upgrade
    if (this.#data.uninstall) output.uninstall = this.#data.uninstall
    if (this.#data.logging) output.logging = this.#data.logging
    if (this.#data.install_cleanup) {
      output.install_cleanup = this.#data.install_cleanup
    }
    if (this.#data.files.length) output.files = this.#data.files
    if (this.#data.dirs.length) output.dirs = this.#data.dirs
    if (this.#data.symlinks.length) output.symlinks = this.#data.symlinks
    if (this.#data.run.length) output.run = this.#data.run
    if (this.#data.shortcuts.length) output.shortcuts = this.#data.shortcuts
    if (this.#data.registry.length) output.registry = this.#data.registry
    if (this.#data.com.length) output.com = this.#data.com
    if (this.#data.plist.length) output.plist = this.#data.plist
    if (this.#data.launchd.length) output.launchd = this.#data.launchd

    return toml.stringify(output as Record<string, unknown>)
  }

  async write(filePath: string): Promise<void> {
    await Deno.writeTextFile(filePath, this.build())
  }

  #requirePlatform(want: OuttoPlatform, method: string): void {
    if (this.#platform !== want) {
      throw new Error(
        `OuttoBuilder.${method}() is only valid for platform "${want}"; ` +
          `current platform is "${this.#platform}"`,
      )
    }
  }
}
