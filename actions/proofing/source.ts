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
