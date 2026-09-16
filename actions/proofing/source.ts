export type ProofingSource = "grammar" | "speller"

export function proofingSource(config?: {
  "grammar-checkers"?: boolean
  spellers?: boolean
}): ProofingSource | undefined {
  if (config?.["grammar-checkers"] === true) return "grammar"
  if (config?.spellers === true) return "speller"
}

export function proofingArtifact(source: ProofingSource): string {
  return source === "grammar"
    ? "build/tools/grammarcheckers/*.drb"
    : "build/tools/proofing/bundle.drb"
}

/**
 * BCP-47 tags the language covers, taken from the keys of
 * `windows.extra_locales` (the values are zhfst prefixes and are irrelevant
 * here). Lives under `[windows]` for historical reasons, but the tags are not
 * Windows-specific: LibreOffice's language table is a port of the Microsoft
 * one, so the same set applies there.
 *
 * Passed to `divvun-runtime bundle --locales` so the bundle records which
 * regional variants to offer, instead of every consumer shipping its own
 * language table.
 */
export function proofingLocales(manifest: {
  windows?: { extra_locales?: Record<string, string> }
}): string[] {
  return Object.keys(manifest.windows?.extra_locales ?? {})
}

export function proofingPackage(
  source: ProofingSource,
  manifest: {
    package: {
      speller: { name: string; version: string }
      grammar?: { name: string; version: string }
    }
  },
  langTag = manifest.package.speller.name,
): { name: string; version: string } {
  // A grammar stanza can exist even when grammar-checkers is false (e.g. sjd).
  if (source === "speller") return manifest.package.speller
  // Preserve the existing combined bundle's metadata fallbacks.
  return {
    name: manifest.package.grammar?.name ?? langTag,
    version: manifest.package.grammar?.version ??
      manifest.package.speller.version,
  }
}
