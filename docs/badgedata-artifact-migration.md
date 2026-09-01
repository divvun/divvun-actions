# Move badgedata & test data out of `lang-` repos → rolling `generated/docs-data` branch

Tracking issue: [divvun/divvun-actions#19](https://github.com/divvun/divvun-actions/issues/19)

## Goal

`lang-` repos stop carrying generated data on `main`. Every `main` build on
Buildkite regenerates it and publishes it to a **rolling orphan branch**
(`generated/docs-data`) on that repo. The docs site and README badges consume it by
**stable URL / runtime fetch** from `raw.githubusercontent.com`, so the docs
pipeline and the language build never need to be synchronised.

### Principle

The docs site _references_ build outputs by stable URL; it does not embed them
at build time. Consequences:

- **Badges** → shields.io `endpoint` badges pointed at
  `raw.githubusercontent.com/giellalt/<repo>/generated/docs-data/<file>.json`. Update
  live, server-side. No docs rebuild.
- **Typos report** → the `accuracy-viewer` SPA `fetch()`es `report.json` from
  the same `generated/docs-data` URL at runtime. No docs rebuild.
- **testlogs** → one committed shell page + a theme renderer that fetches
  `testlogs.json` from the `generated/docs-data` URL. No docs rebuild.
- `giellalt/.github`'s `docs.yml` is **not touched**. No `on: push` change, no
  cross-system trigger, no `actions:write` token in Buildkite.

### Why a branch and not a GitHub Release

The first cut of this used a rolling `docs-latest` **Release** (same pattern as
the `speller-<lang>/dev-latest` nightlies). It works for shields.io — which
fetches server-side — but **not for the browser**: a release asset URL
(`github.com/<o>/<r>/releases/download/<tag>/<file>`) 302s to
`release-assets.githubusercontent.com`, and **neither hop sends
`Access-Control-Allow-Origin`**, so a cross-origin `fetch()` from
`giellalt.github.io` is blocked by CORS. `raw.githubusercontent.com` sends
`access-control-allow-origin: *` and is CDN-fronted with no meaningful rate
limit; the `api.github.com` asset-download endpoint also works but is
rate-limited to 60 req/hr per IP unauthenticated. So the data has to be on a
**git ref** that `raw.githubusercontent.com` can serve.

`generated/docs-data` is an **orphan branch, force-pushed on every successful
`main` build** — it always holds exactly the latest build's generated data,
one commit, no history. `main` never carries the files, so a normal working
checkout is unaffected. A _full_ `git clone` fetches all branches and so gets
`generated/docs-data`'s current tree (≈1 KB of badge JSON for a healthy repo;
a few MB for a repo with megabytes of persistent test failures — but it never
grows).

The `generated/` prefix is deliberate: Fork, Tower and GitKraken fold
slash-namespaced branches into one collapsible folder, so the CI-managed
branch reads as clearly-not-yours instead of sitting top-level next to `main`.
The commit message carries `[skip ci]` so the push itself spawns no build.
We considered a dedicated `giellalt/docs-data` repo to keep the language
repos completely ref-free; rejected — it trades one well-named branch per
repo for a permanent new repo, cross-repo push auth, rename fragility, and a
170-branch bucket that is _also_ ugly, and buys nothing on
reliability/concurrency (per-repo branches already have zero contention).

### History: `generated/docs-data` (transport) vs `generated/docs-metrics` (trend)

`generated/docs-data` is a transport buffer, not an archive — the browser pages only ever
need the _current_ payload. Keeping full history there is not viable:
`lang-sme`'s `report.json` is **11 MB** (it embeds the per-word result array;
only the ~600-byte `.summary` carries trend signal) and it churns almost
entirely every build; active repos build `main` several times a day. That is
GB/year on one branch, un-prunable without rewriting the ref.

The trend use case — "how has the speller improved over time" — needs only the
compact summaries, and those are cheap to keep forever (~1 KB/build). **Planned
follow-up, not built yet:** a normal-history `generated/docs-metrics` branch (or a single
shared `giellalt/lang-metrics` repo) that appends one `metrics.jsonl` line per
build:

```json
{
  "commit": "a1b2c3d4",
  "date": "2026-09-01T10:42:14Z",
  "build": 238,
  "lemmas": 12345,
  "first_position_pct": 83.2,
  "top_five_pct": 94.8,
  "true_positive": 10673,
  "suites": { "nouns": 100.0, "verbs": 98.1 }
}
```

Decoupling it from `generated/docs-data` keeps "I want trends" independent of "I need a
CORS-friendly blob store". Ship `generated/docs-data` first; add `generated/docs-metrics` when
someone asks.

### Data classes

| Class                                                                                      | Produced by                                               | Timing problem?                         |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------- | --------------------------------------- |
| **1** – `fst-maturity`, `fst-version`, `fst-lemmacount`, `fst-variants`, `speller-version` | regenerable without an FST build (`make -C docs`)         | no                                      |
| **2** – `speller-suggestions(.json / -<variant>.json)`, `report.json`, `testlogs/*`        | needs the built speller + corpus run → **Buildkite only** | yes — solved by URL/runtime consumption |

Buildkite will publish **all** of them (it can regenerate Class 1 trivially), so
there is one canonical source.

### Is any of badgedata hand-authored? (No.)

Every `docs/badgedata/*.json` + `report.json` target in giella-core's
`am-shared/docs-dir-include.am` is a `FORCE` target — regenerated
unconditionally on every `make`. None is meant to be hand-edited:

| File                       | Source of truth                                                                   | Needs FST/speller build? |
| -------------------------- | --------------------------------------------------------------------------------- | ------------------------ |
| `fst-lemmacount.json`      | `count-all-lemmas.sh` over the lexc source                                        | no                       |
| `fst-version.json`         | `AC_INIT([...],[x.y.z])` in `configure.ac`                                        | no                       |
| `speller-version.json`     | `AC_SUBST([SPELLERVERSION],[...])` in `configure.ac`                              | no                       |
| `fst-variants.json`        | `.build-config.yml` + configure-substituted vars                                  | no (needs `configure`)   |
| `fst-maturity.json`        | **GitHub repo topics API** (`maturity-beta` → yellow) — reads nothing in the repo | no                       |
| `speller-suggestions.json` | derived from `report.json` `.summary`                                             | yes                      |
| `report.json`              | `divvunspell accuracy` on the built `.zhfst` + `typos.tsv`                        | yes                      |

The only maintainer-set knobs are the **GitHub repo topic** for maturity (lives
on GitHub, not the repo) and version strings in `configure.ac`. The badge JSON
is a generated cache. `make badgedata` stays available for local preview — it
just writes to a gitignored path.

---

## Status

### Done / merged

- [x] **giella-core** – `speller-report` removal merged (`a0a016e4`, PR #456);
      `report.json` recipe fixed to `$(DIVVUNSPELL) accuracy` (`bbd4c2ab`, main,
      unpushed).
- [x] **template-lang-und** – `speller-report` removal on `main` (`8cacf2c`).
- [x] **170 `lang-` repos** – `speller-report` removal committed locally
      (`.gut/delta.toml` → rev 331). **Needs `gut push -r '^lang-'`** (Phase 0).
- [x] **GiellaLTLexTools** – `-J/--json-file` on `gtlemmatest`/`gtspelltest`,
      v0.10.0, branch `json-output`, **pushed**.

### On branches, unpushed

- **template-lang-und** `testlogs-client-render` – `index.md`→`index.html`
  swap, `-J` in the 5 test `.sh.in` scripts, `rev_id 333`.
- **jekyll-theme-giellalt** `testlogs-client-render` – `assets/js/testlogs.js`
  - CSS.
- **divvun-actions** `lang-docs-artifacts` – the `docs-publish` step + action.
- **lang-olo** `testlogs-client-render` (also merged to `main`) – test bed.

### Loose ends to settle first

- [x] template rev 332 (`Readme formatting`) — reverted; template `main` is
      back at rev 331 (`8cacf2c`).
- [ ] Stray tracked `.orig` files from an earlier botched run:
      `lang-sme/.gitignore.orig`, `lang-sjd-x-private/docs/_config.yml.orig`,
      `lang-sjd-x-private/m4/giella-config-files.m4.orig`. Separate tiny cleanup.

---

## Workstream 1 — giella-core: generated files become artifacts, not commits

Repo: `giellalt/giella-core`

- [ ] **`am-shared/docs-dir-include.am`** – the badge-JSON and `report.json`
      targets currently write into `$(srcdir)` (tracked). Point them at
      `$(builddir)` instead, or otherwise keep them out of the tracked tree.
      This also removes the reason `divvun-actions`'
      `actions/lang/common.ts::updateDependencyRepo` has to `git checkout -- .` a
      dirtied giella-core checkout on every build.
- [ ] Drop the generated files from any committed `doc_DATA` / `EXTRA_DIST`
      expectation so `make` / `make install` don't expect them in the source tree.
- [x] **`$(DIVVUN_ACCURACY)` was undefined** – fixed in `bbd4c2ab`: the
      `report.json` recipe now calls `$(DIVVUNSPELL) accuracy` (the same binary m4
      already probes for the spellchecker tests).
- [ ] **`.gitignore`** – ignore `docs/badgedata/`, `docs/testlogs/`,
      `docs/report.json`, `docs/typosreport/report*.json`.
- [ ] Confirm the Class 1 badge scripts still run standalone in the
      `giellalt/.github` `docs.yml` context (they already do — `make-maturity`
      curls the topics API, `make-version` greps `configure.ac`, `make-lemmacount`
      greps lexc, `make-fst-variants` reads `.build-config.yml` + configure vars).

## Workstream 2 — divvun-actions: the producer

Repo: `divvun/divvun-actions`

- [x] **`pipelines/lang/mod.ts`** – a `Docs` group with one step:
  - key `docs-publish`, label `Publish Docs Data`
  - `command: "divvun-actions run lang-docs-publish"`
  - `main` branch only, `soft_fail: true`
  - `depends_on: "speller-test"`
  - `agents: { queue: "linux", ...extra }`
- [x] **`actions/lang/docs-publish.ts`** – `runLangDocsPublish`:
  1. Reuse the `runLangTests` preamble
     (`downloadAndExtractSpellerSnapshot` + `setupGiellaCoreDependencies` +
     re-`configure`) so the built speller is on disk. Download the
     `docs/testlogs/*-lemmas.json` artifact the test step uploaded.
  2. In `build/docs`, `make` the badge + report targets, guarded by
     `.build-config.yml` flags (`generateDocsData`). **TODO(CI):** the
     `fst-variants.json` make-target name and the variant reports
     (`report-<v>.json` / `speller-suggestions-<v>.json`) are not verified
     against a real build yet — every step is warn-not-throw.
  3. `actions/lang/testlogs.ts` reads the per-suite `*-lemmas.json`
     (gtlemmatest / gtspelltest `-J`, no markdown parsing) → `testlogs.json`
     manifest + one `testlogs-<id>.json` per failing suite. Full failure list,
     no cap; `--oov-limit` (10000) is the only limit and shows as `truncated`.
  4. Assemble the file set: badge `*.json` (+ N variant), `report.json`
     (+ `report-<v>.json`), `testlogs.json` + `testlogs-<id>.json`, `meta.json`
     (`{generated, commit, build_url}`).
  5. **`GitHub.publishBranch("generated/docs-data", files, { orphan: true, message })`**
     — force-pushes a fresh single-commit orphan branch via the GitHub Git Data
     API (`gh api .../git/{blobs,trees,commits,refs}`), no working-tree
     checkout. Authenticated by the same `gh` token that the release path used.
- [ ] Verify `divvunspell accuracy` is on the linux CI image (needed for
      `report.json`); add to the Dockerfile if not.

### testlogs schema

`testlogs.json` — the manifest, a few hundred bytes; the docs page loads only
this on open:

```json
{
  "generated": "2026-09-01T10:42:14Z",
  "commit": "a1b2c3d",
  "build_url": "https://buildkite.com/divvun/lang-sme/builds/1234",
  "suites": [
    {
      "id": "nouns",
      "title": "nouns",
      "kind": "lemma",
      "lexc": "nouns.lexc",
      "lemmas": 91338,
      "success_pct": 100.0,
      "failures": 0,
      "truncated": false
    }
  ]
}
```

`testlogs-<id>.json` — one per suite that has failures; fetched only when that
suite is expanded. `failures` is the `gtlemmatest`/`gtspelltest -J` record,
verbatim (the renderer formats it):

```json
{
  "id": "nouns",
  "kind": "lemma",
  "failures": [
    {
      "lemma": "email",
      "no_generation": ["email+N+Pl+Nom"],
      "wrong_generation": [{ "expected": "email+N+Sg+Nom", "got": "e-mail" }],
      "analyses": ["email+N"]
    }
  ]
}
```

For `"kind": "speller"`, each failure is `{ "lemma": "...", "suggestions": [...] }`.

### Why the split (measured)

`lang-nno` (a badly broken build — every suite hits the 10000-failure limit):

|                        | old: static pre-render                                 | new: manifest + per-suite                                                                                              |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| initial load           | one 0.8–1.9 MB HTML page, all failures flat & laid out | 580 B manifest → summary table, instant                                                                                |
| viewing one broken POS | (that page) ~1.8 MB HTML, ~1–3 s, janky scroll         | fetch `testlogs-adjectives.json` 1.9 MB raw / **0.26 MB gzip**, rendered lazily into collapsed `<details>`, ~0.3–0.8 s |
| all 4 POS              | 6 MB across 4 page loads                               | 6 MB only if you open all 4                                                                                            |

Healthy repos (`lang-sme`, `lang-fit`): manifest ~0.6 KB, per-suite files a few
KB. Trade-off: failure text is no longer in Pagefind search, and the page needs
JS.

## Workstream 3 — badge URL migration

Repos: `template-lang-und` + 170 `lang-` repos

- [ ] **`template-lang-und`**: in `README.md` and `docs/index-header.md`, change
      the shields `url=` from
      `…raw.githubusercontent.com/giellalt/__REPO__/main/docs/badgedata/X.json`
      to
      `…raw.githubusercontent.com/giellalt/__REPO__/generated/docs-data/X.json`.
      Bump `rev_id`.
- [ ] **`gut apply` script** across `^lang-` to make the same substitution in
      each repo's `README.md` + `docs/index-header.md` (content-anchored `perl`,
      like the `speller-report` removal). Skip any repo with no `generated/docs-data` branch
      yet (`git ls-remote --heads origin generated/docs-data`) so a badge never points at a
      missing ref. Bump each repo's `.gut/delta.toml`. `gut commit` + `gut push`.
- [ ] _(optional, later)_ teach giella-core's `$(INDEX)` rule to emit the badge
      block so the URL pattern lives in exactly one place going forward.

> shields.io fetches endpoint URLs server-side; `raw.githubusercontent.com`
> sends a JSON content-type and `access-control-allow-origin: *`, so it works
> for both shields and the browser.

## Workstream 4 — typos report viewer: runtime fetch

Repo: `giellalt/accuracy-viewer` (the Svelte source for
`docs/typosreport/bundle.js`) — **confirm exact repo name**

- [ ] Today the viewer `fetch()`es `report.json` and
      `../badgedata/fst-variants.json` **same-origin** from the Pages site, so it
      has no CORS problem _yet_ — moving those files off the repo creates one.
      Change both fetches to
      `https://raw.githubusercontent.com/<owner>/<repo>/generated/docs-data/…`.
      Derive `<owner>/<repo>` from a `data-` attribute on the mount node injected
      at Jekyll build time (`{{ site.github.repository_nwo }}`), same as testlogs.
- [ ] Rebuild the bundle; re-sync `bundle.js` / `bundle.css` into
      `template-lang-und/docs/typosreport/`; bump `rev_id`; propagate via `gut`.
- [ ] Keep `docs/typosreport/{index.html,bundle.js,bundle.css,global.css}`
      committed — that's the viewer app shell, not generated data.

## Workstream 5 — testlogs: native JSON + client rendering

Repos: `divvun/GiellaLTLexTools`, `giellalt/template-lang-und`,
`giellalt/jekyll-theme-giellalt`

- [x] **GiellaLTLexTools** `-J/--json-file` on `gtlemmatest` / `gtspelltest`
      (branch `json-output`, v0.10.0). Structured per-suite JSON — no markdown
      parsing anywhere downstream.
- [ ] **`template-lang-und`** – the 5 test scripts
      (`src/fst/morphology/test/generate-*-lemmas.sh.in`,
      `tools/spellcheckers/test/accept-all-lemmas.sh.in`) pass
      `-J "@abs_top_srcdir@/docs/testlogs/$POS-lemmas.json"` alongside the existing
      `-L`. Bump `rev_id`. (branch `testlogs-client-render`, done — rev 333.)
      Requires GiellaLTLexTools >= 0.10.0 on the build agents (CI installs from
      `main`, so already true; local devs `pipx upgrade`).
- [ ] **`jekyll-theme-giellalt/assets/js/testlogs.js`** – vanilla renderer:
      loads the manifest → summary table (Test · Lemmas · Success % · Failures);
      each failing suite is a `<details>` that fetches its `testlogs-<id>.json`
      on first open and formats the `-J` failure records (no-generation /
      wrong-generation / analyses, or speller suggestions) into bullet lists.
      Provenance line; graceful "no results yet" fallback (404 on the manifest =
      branch not published yet). **Now points at the `generated/docs-data` raw URL.**
- [ ] Theme CSS: `.testlogs-summary`, `.testlogs-note`, `#testlogs details`
      (~20 lines; done on the branch).
- [ ] **`template-lang-und/docs/testlogs/index.html`** – replaces `index.md`:

  ```html
  ---
  layout: default
  title: Automatic test logs
  generated: true
  ---
  <h1>Log files for automatic testing</h1>
  <p>Detailed lemma-test results, published per build and loaded live —
     not committed to the repo.</p>
  <div id="testlogs"
    data-src="https://raw.githubusercontent.com/{{ site.github.repository_nwo }}/generated/docs-data/testlogs.json">
    <p class="testlogs-note">Loading latest test results…</p>
  </div>
  <script src="{{ '/assets/js/testlogs.js' | relative_url }}" defer></script>
  ```

- [ ] `template.toml`: remove `docs/testlogs/index.md` from `required`, add
      `docs/testlogs/index.html`. Bump `rev_id`.

## Workstream 6 — repo cleanup

Repos: `template-lang-und` + 170 `lang-` repos

- [ ] Fold into the same `gut apply` pass as Workstream 3:
  ```
  git rm -r --ignore-unmatch \
    docs/badgedata docs/testlogs \
    docs/report.json docs/typosreport/report*.json
  git rm --ignore-unmatch docs/testlogs/index.md   # replaced by index.html from template
  ```
- [ ] `.gitignore` (repo + `docs/.gitignore`, and in the template): add
      `docs/badgedata/`, `docs/testlogs/`, `docs/report.json`,
      `docs/typosreport/report*.json`.
- [ ] Git history on `main` is **left intact** (decision from #19 planning) —
      stop the growth, don't rewrite.

## Workstream 7 — giellalt/.github: verify only

- [ ] Confirm `make -C docs` in `docs.yml` still succeeds after the giella-core
      changes (badge targets still present; they now just also get published by
      Buildkite).
- [ ] _(later cleanup)_ the docs-workflow-generated `docs/badgedata/*.json` are
      now unused (shields reads the `generated/docs-data` URL). Can drop the badge targets
      from the docs build once everything is cut over.

---

## Rollout strategy

The change has two layers with opposite risk profiles, so they get opposite
treatment:

- **Producers** (giella-core, GiellaLTLexTools, divvun-actions, theme) — the
  new behaviour is additive, `soft_fail`, or behind an on-demand flag, and it
  **cannot be verified end to end without running in prod CI** (a branch build
  won't populate a real `generated/docs-data` branch). So: normal PR review, merge to
  main, let `generated/docs-data` populate, iterate on `docs-publish` from there. A bad
  publish is fixed by the next build — that is the whole point of a rolling
  branch.
- **The per-repo flip** (badge URLs, `git rm`, `index.html`) — user-visible
  (every language's README), and it has already bitten us twice via `gut`. This
  stays **conservative**: canary → soak → batched `gut apply` with a tested
  revert script.

### Phase 0 — warm-up: push the speller-report removal

Unrelated to the artifact work, already done and reviewed, low risk.

- [x] merge giella-core `remove-speller-report` (`a0a016e4` on main)
- [ ] `gut push -r '^lang-'` the 170 local `speller-report` commits

### Phase 1 — land the producers (main)

Merge order matters (GiellaLTLexTools before its callers):

1. [x] **giella-core** `bbd4c2ab` (main, unpushed) — inert for existing flows;
       only `docs-publish` reaches the `report.json` target.
2. [x] **GiellaLTLexTools** `json-output` (v0.10.0) → **pushed** (branch).
       `divvun-actions` installs it with `uv pip install --upgrade git+…` on every
       build. `-L` behaviour is byte-identical.
3. [ ] **template-lang-und** — `-J` in the 5 test `.sh.in` scripts (rev 333).
       Test in one repo first (Phase 1.5).
4. [ ] **divvun-actions** `lang-docs-artifacts` → PR with real review (new prod
       CI behaviour; it force-pushes a `generated/docs-data` branch to every lang repo).
       After merge, every `lang-` `main` build publishes `generated/docs-data`. Nothing
       consumes it yet.

### Phase 1.5 — prove `-J` + the publish path in one repo (`lang-olo`)

`lang-olo` is the test bed (small speller, real failures, builds fast):

- [x] `-J` in the 5 `.sh.in` scripts on `lang-olo` `testlogs-client-render`
      (also merged to `main`).
- [x] `docs/testlogs/index.html` shell page; `_config.yml` `remote_theme`
      pinned to the theme's `testlogs-client-render` branch.
- [ ] Point `index.html` `data-src` at the `generated/docs-data` raw URL.
- [ ] Run a `main` build → confirm `docs-publish` force-pushes `generated/docs-data` with
      `testlogs.json` + `testlogs-<id>.json` + badge JSON + `meta.json`.
- [ ] `https://giellalt.github.io/lang-olo/testlogs/` renders the summary and a
      failing suite expands.

### Phase 2 — verify across a spread (no repo changes)

Let `generated/docs-data` populate. Check:

| repo                       | why                                                    |
| -------------------------- | ------------------------------------------------------ |
| `lang-sme`                 | healthy, spellers + grammar + dialects                 |
| `lang-nno`                 | tests badly broken (the `truncated` / large-file path) |
| a variant repo             | dialect/area/alt-orth report variants                  |
| a small analyser-only repo | no speller → no `report.json` / speller badges         |

For each: badge JSONs are valid shields endpoints; `testlogs.json` +
`testlogs-<id>.json` present and well-formed; `report.json` present and
non-empty (spellers only); `generated/docs-data` branch exists with one commit.

Fix the `TODO(CI)` items in `docs-publish.ts` (make-target names, VPATH paths,
variant reports) as divvun-actions PRs — each fix re-publishes on the next
build.

### Phase 3 — land the theme + canary the flip

5. [ ] **jekyll-theme-giellalt** `testlogs-client-render` → PR → main. Inert:
       `testlogs.js` only loads on a page that includes it.
6. [ ] Canary **`lang-sme`, `lang-nno`, one variant repo** — one hand-made
       commit each:
   - swap `docs/testlogs/index.md` → the new `index.html`
   - flip README + `docs/index-header.md` badge `url=` to the `generated/docs-data` URL
   - `git rm -r docs/badgedata` and `git rm docs/testlogs/*-lemmas.{md,json}`
   - **keep** `docs/typosreport/` (incl. `report.json`) — that waits for Phase 4
   - add `.gitignore` entries
   - Push, watch: Pages build green, README badges render, `/testlogs/` works.
   - **Soak 3–7 days.**

### Phase 4 — typos report viewer

7. [ ] **accuracy-viewer** (Workstream 4): `fetch()` `report.json` +
       `fst-variants.json` from the `generated/docs-data` URL; rebuild bundle; sync into the
       template; canary on the same three repos.
8. [ ] Once green, the canary repos drop `docs/typosreport/report*.json` too.

### Phase 5 — batch the flip to all 170

9. [ ] One `gut apply` script doing Phase 3's + Phase 4's per-repo edits.
   - skip any repo with no `generated/docs-data` branch (report them; trigger a build)
   - bump each repo's `.gut/delta.toml`
   - `gut commit` + spot-check ~5 + `gut push`
10. [ ] Keep a **revert script** ready (restore files from `git`, restore badge
        URLs).

### Phase 6 — cleanup

11. [ ] **giellalt/.github** (Workstream 7): drop the now-vestigial badge
        targets from `make -C docs`. Optional.
12. [ ] Once the JSON path is proven everywhere, consider dropping `-L`
        (markdown) from the test `.sh.in` scripts. Keep it while local devs still
        open the `.md` logs.
13. [ ] _(when asked)_ add the `generated/docs-metrics` branch / `giellalt/lang-metrics`
        append for accuracy trends.

## Rollback per phase

| phase       | to undo                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0–2         | revert the PR; next build is back to normal; a stale `generated/docs-data` branch is harmless (or `git push origin --delete generated/docs-data`) |
| 3 canary, 4 | per-repo `git revert` restores the committed files + old badge URLs                                                                               |
| 5           | run the revert script over `^lang-`                                                                                                               |

## Verification checklist

- `generated/docs-data` branch on a canary repo carries: badge `*.json`, `report.json`
  (spellers), `testlogs.json` + `testlogs-<id>.json`, `meta.json` — one orphan
  commit, no history.
- `https://img.shields.io/endpoint?url=…raw.githubusercontent.com/giellalt/<repo>/generated/docs-data/fst-maturity.json`
  renders.
- Canary Pages build green; `/testlogs/` summary loads instantly, a failing
  suite expands and fetches its file; `/typosreport/` loads (Phase 4+).
- `git clone` size of a canary repo's `main` stops growing build-over-build;
  `generated/docs-data`'s tree doesn't accumulate.
- Break a lemma test on a branch → merge → next `main` build's `generated/docs-data` and
  the live `/testlogs/` page reflect it, with no docs rebuild.

---

## Follow-ups / out of scope

- **`generated/docs-metrics`** — the compact accuracy-trend log (see "History" above).
- `corpus-` repos — same pattern, separate pass.
- `keyboard` / `dict` / `speech` repo types — later.
- **`gut` cannot delete files** removed from a template's `required` list —
  template file removals always need a manual `git rm` pass. Raise with the
  `gut` maintainer.
- `gut template apply` is patch-based and fragile against any local divergence;
  never use it for bulk reformatting — use `gut apply` scripts.

## Open questions

- Exact repo name for the `accuracy-viewer` Svelte source.
- Keep publishing Class 1 badges from the `docs.yml` build as a redundant path,
  or make Buildkite the sole publisher?
- Add a `gtlemmatest` version gate to giella-core's `configure.ac` so an agent
  with GiellaLTLexTools < 0.10.0 fails cleanly at configure rather than with an
  argparse error mid-`make check`?
- `generated/docs-data` as a true orphan (force-push, no history) is the plan; revisit if
  a per-build diff of the badge JSON turns out to be worth keeping cheaply.
