# Spelling-only x-proofing bundles

On main and `x-proofing-*/v*` tags, the language pipeline selects its proofing
source from `.build-config.yml`:

| Enabled features | DRB producer | Package name/version |
| --- | --- | --- |
| Grammar | `grammar-build` (existing combined pipeline) | `package.grammar` |
| Spellers, grammar disabled | `speller-build` → `proofing-build` | `package.speller` |
| Neither | No proofing packages | — |

The spelling-only build restores the speller workspace and configure flags,
with grammar disabled. It requests the HFST support models explicitly. Some
models retain `gramcheck` filenames because the existing runtime spelling
commands use those CG tags; this does not compile or run grammar rules.

The default DRB pipeline tokenizes, preserves whitespace, resolves/splits
multiword tokens, runs cgspell, marks spelling errors, and calls divvun.suggest
to produce the same GrammarOutput JSON used by proofing consumers. It does not
run the language disambiguator or grammarchecker. The spelling rules mark unknown readings even when they have no suggestions. The fallback error description
is English. Grammar-enabled languages retain their own pipelines and messages.

The new Linux job bundles and smoke-loads the DRB before uploading it. All three
OS jobs consume that one artifact: outto on Windows/macOS and a flat archive on
Linux. Experimental soft-failure and GitHub-only release behavior are retained.

Local checks: `deno check cli.ts`; `deno test --allow-read --allow-write
actions/proofing/source_test.ts actions/proofing/speller_test.ts`. The pipeline
test additionally requires access to the Buildkite metadata environment names
read by `util/env.ts`, but needs no network, subprocesses, credentials or live CI.
An end-to-end model build requires the Linux language CI toolchain.

Validation for the initial change: the 36-case pipeline matrix and staging tests
pass. The new pipeline was bundled and executed with Divvun Runtime 0.4.0 using
the six spelling support models from the published Lule Sami
`grammar-smj/dev-latest` archive (build 257). `mánná mánnná` preserved the text,
reported only `mánnná` as a spelling error, and suggested `mánná`; empty input
returned an empty GrammarOutput. This verifies the runtime composition, not
SJD model compilation. The complete Linux make sequence still needs CI validation.
The action uses commands and output schemas present in CI's pinned runtime 0.3.1.
