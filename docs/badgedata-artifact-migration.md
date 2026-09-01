# Move badgedata & test data out of `lang-` repos → rolling GitHub Release

Tracking issue: [divvun/divvun-actions#19](https://github.com/divvun/divvun-actions/issues/19)

## Goal

`lang-` repos stop carrying generated data on `main`. Every `main` build on
Buildkite regenerates it and publishes it to a **rolling GitHub Release**
(`docs-latest`) on that repo. The docs site and README badges consume it by
**stable URL / runtime fetch**, so the docs pipeline and the language build
never need to be synchronised.

### Principle

The docs site *references* build outputs by stable URL; it does not embed them
at build time. Consequences:

- **Badges** → shields.io `endpoint` badges pointed at release-asset URLs.
  Update live, server-side. No docs rebuild.
- **Typos report** → the `accuracy-viewer` SPA `fetch()`es `report.json` from
  the release URL at runtime. No docs rebuild.
- **testlogs** → one committed shell page + a theme renderer that fetches
  `testlogs.json` from the release URL. No docs rebuild.
- `giellalt/.github`'s `docs.yml` is **not touched**. No `on: push` change, no
  cross-system trigger, no `actions:write` token in Buildkite.

### Data classes

| Class | Produced by | Timing problem? |
|---|---|---|
| **1** – `fst-maturity`, `fst-version`, `fst-lemmacount`, `fst-variants`, `speller-version` | regenerable without an FST build (`make -C docs`) | no |
| **2** – `speller-suggestions(.json / -<variant>.json)`, `report.json`, `testlogs/*` | needs the built speller + corpus run → **Buildkite only** | yes — solved by URL/runtime consumption |

Buildkite will publish **all** of them (it can regenerate Class 1 trivially), so
there is one canonical source.

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
  + CSS.
- **divvun-actions** `lang-docs-publish` – the `docs-publish` step + action.

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
- [ ] **`$(DIVVUN_ACCURACY)` is undefined** – it is referenced in
  `docs-dir-include.am` but no `configure.ac` / m4 sets it, so the `report.json`
  and (removed) `speller-report` recipes silently run with an empty command.
  Add an `AC_SUBST` / `AC_PATH_PROG` (it is the `accuracy` subcommand of
  `divvunspell`, which m4 already probes as `$DIVVUNSPELL`). Needed for
  `report.json` to actually generate in CI.
- [ ] **`.gitignore`** – ignore `docs/badgedata/`, `docs/testlogs/`,
  `docs/report.json`, `docs/typosreport/report*.json`.
- [ ] Confirm the Class 1 badge scripts still run standalone in the
  `giellalt/.github` `docs.yml` context (they already do — `make-maturity`
  curls the topics API, `make-version` uses git, `make-lemmacount` greps lexc,
  `make-fst-variants` reads `.build-config.yml` + configure vars).

## Workstream 2 — divvun-actions: the producer

Repo: `divvun/divvun-actions`

- [ ] **`pipelines/lang/mod.ts`** – add a `Docs` group with one step:
  - key `docs-publish`, label `Publish Docs Data`
  - `command: "divvun-actions run lang-docs-publish"`
  - `main` branch only, `soft_fail: true`
  - `depends_on` the speller-test (and grammar-test, when enabled) steps
  - `agents: { queue: "linux", ...extra }`
- [ ] **`actions/lang/docs-publish.ts`** – new action + `runLangDocsPublish` in
  `pipelines/lang/mod.ts`:
  1. Reuse the `runLangTests` preamble (`downloadAndExtractSpellerSnapshot` +
     `setupGiellaCoreDependencies` + re-`configure`) so the built speller is on
     disk. The test step already ran `make check` and uploaded
     `docs/testlogs/*-lemmas.json`; download that artifact.
  2. In `build/docs`, `make` the badge + report targets, guarded by
     `.build-config.yml` flags:
     `badgedata/fst-lemmacount.json badgedata/fst-maturity.json
     badgedata/fst-version.json badgedata/fst-variants.json
     badgedata/speller-version.json badgedata/speller-suggestions.json
     report.json`
     plus the variant files `badgedata/speller-suggestions-<variant>.json`.
  3. Read the per-suite `docs/testlogs/*-lemmas.json` that
     `gtlemmatest`/`gtspelltest -J` wrote (GiellaLTLexTools >= 0.10.0), and
     from them write a small **`testlogs.json`** manifest plus one
     **`testlogs-<pos>.json`** per failing suite (schema below).
     `actions/lang/testlogs.ts` does this — no markdown parsing. The full
     failure list is kept — no cap; `gtlemmatest`'s own `--oov-limit` (10000)
     is the only limit and shows up as `truncated`.
  4. Assemble release assets:
     - loose: the 6 (+ N variant) badge `*.json`
     - `report.json` (+ `report-<variant>.json`)
     - `testlogs.json` + `testlogs-<pos>.json` (one per failing suite)
  5. `const gh = new GitHub(builder.env.repo);
     await gh.updateRelease("docs-latest", [...assets],
     { draft: false, prerelease: true, name: "Docs data (latest main build)" })`
     — same mechanism as the existing `speller-<lang>/dev-latest` nightlies.
  6. Point the `docs-latest` git tag at the built commit (`git tag -f` + push,
     or `gh release edit --target <sha>`) so the release page shows the right
     commit.
- [ ] Verify `divvun-accuracy` / `divvunspell accuracy` is on the linux CI
  image (needed for `report.json`); add to the Dockerfile if not.

### testlogs schema

`testlogs.json` — the manifest, a few hundred bytes; the docs page loads only
this on open:

```json
{
  "generated": "2026-09-01T10:42:14Z",
  "commit": "a1b2c3d",
  "build_url": "https://buildkite.com/divvun/lang-sme/builds/1234",
  "suites": [
    { "id": "nouns", "title": "nouns", "kind": "lemma", "lexc": "nouns.lexc",
      "lemmas": 91338, "success_pct": 100.0,
      "failures": 0, "truncated": false }
  ]
}
```

`testlogs-<pos>.json` — one per suite that has failures; fetched only when that
suite is expanded. `failures` is the `gtlemmatest`/`gtspelltest -J` record,
verbatim (the renderer formats it):

```json
{
  "id": "nouns",
  "kind": "lemma",
  "failures": [
    { "lemma": "email",
      "no_generation": ["email+N+Pl+Nom"],
      "wrong_generation": [{ "expected": "email+N+Sg+Nom", "got": "e-mail" }],
      "analyses": ["email+N"] }
  ]
}
```

For `"kind": "speller"`, each failure is `{ "lemma": "...", "suggestions": [...] }`.

### Why the split (measured)

`lang-nno` (a badly broken build — every suite hits the 10000-failure limit):

| | old: static pre-render | new: manifest + per-suite |
|---|---|---|
| initial load | one 0.8–1.9 MB HTML page, all failures flat & laid out | 580 B manifest → summary table, instant |
| viewing one broken POS | (that page) ~1.8 MB HTML, ~1–3 s, janky scroll | fetch `testlogs-adjectives.json` 1.9 MB raw / **0.26 MB gzip**, rendered lazily into collapsed `<details>`, ~0.3–0.8 s |
| all 4 POS | 6 MB across 4 page loads | 6 MB only if you open all 4 |

Healthy repos (`lang-sme`, `lang-fit`): manifest ~0.6 KB, per-suite files a few
KB. Trade-off: failure text is no longer in Pagefind search, and the page needs
JS.

## Workstream 3 — badge URL migration

Repos: `template-lang-und` + 170 `lang-` repos

- [ ] **`template-lang-und`**: in `README.md` and `docs/index-header.md`, change
  the shields `url=` from
  `…raw.githubusercontent.com/giellalt/__REPO__/main/docs/badgedata/X.json`
  to
  `…github.com/giellalt/__REPO__/releases/download/docs-latest/X.json`.
  Bump `rev_id`.
- [ ] **`gut apply` script** across `^lang-` to make the same substitution in
  each repo's `README.md` + `docs/index-header.md` (content-anchored `perl`,
  like the `speller-report` removal). Bump each repo's `.gut/delta.toml`.
  `gut commit` + `gut push`.
- [ ] *(optional, later)* teach giella-core's `$(INDEX)` rule to emit the badge
  block so the URL pattern lives in exactly one place going forward.

> shields.io fetches endpoint URLs server-side, so GitHub's
> `application/octet-stream` content-type and the redirect to
> `objects.githubusercontent.com` are fine.

## Workstream 4 — typos report viewer: runtime fetch

Repo: `giellalt/accuracy-viewer` (the Svelte source for
`docs/typosreport/bundle.js`) — **confirm exact repo name**

- [ ] Change `fetch("report.json")` and the variant-discovery
  `fetch("../badgedata/fst-variants.json")` to fetch from
  `https://github.com/<owner>/<repo>/releases/download/docs-latest/…`.
  Derive `<owner>/<repo>` from `window.location` (Pages host + path) or a
  `data-` attribute on the mount node injected at Jekyll build time.
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
  Provenance line; graceful "no results yet" fallback.
- [ ] Theme CSS: `.testlogs-summary`, `.testlogs-note`, `#testlogs details`
  (~20 lines; table + `<code>` styling already exists).
- [ ] **`template-lang-und/docs/testlogs/index.html`** – replace the current
  `index.md` with the shell page:

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
       data-src="https://github.com/{{ site.github.repository_nwo }}/releases/download/docs-latest/testlogs.json">
    <p class="testlogs-loading">Loading latest test results…</p>
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
- [ ] Git history is **left intact** (decision from #19 planning) — stop the
  growth, don't rewrite.

## Workstream 7 — giellalt/.github: verify only

- [ ] Confirm `make -C docs` in `docs.yml` still succeeds after the giella-core
  changes (badge targets still present; they now just also get published by
  Buildkite).
- [ ] *(later cleanup)* the docs-workflow-generated `docs/badgedata/*.json` are
  now unused (shields reads the release URL). Can drop the badge targets from
  the docs build once everything is cut over.

---

## Rollout strategy

The change has two layers with opposite risk profiles, so they get opposite
treatment:

- **Producers** (giella-core, GiellaLTLexTools, divvun-actions, theme) — the
  new behaviour is additive, `soft_fail`, or behind an on-demand flag, and it
  **cannot be verified end to end without running in prod CI** (a branch build
  won't populate real `docs-latest` releases). So: normal PR review, merge to
  main, let the releases populate, iterate on `docs-publish` from there. A bad
  publish is fixed by the next build — that is the whole point of a rolling
  release.
- **The per-repo flip** (badge URLs, `git rm`, `index.html`) — user-visible
  (every language's README), and it has already bitten us twice via `gut`. This
  stays **conservative**: canary → soak → batched `gut apply` with a tested
  revert script.

The flip is *inherently* incremental — it's a commit in each repo — so you
control the pace regardless.

### Phase 0 — warm-up: push the speller-report removal

Unrelated to the artifact work, already done and reviewed, low risk (removes
dead links/files). Push it first to re-prove the `gut apply → gut commit → gut
push` flow on something safe.

- [ ] merge giella-core `remove-speller-report` (done: `a0a016e4` on main)
- [ ] `gut push -r '^lang-'` the 170 local `speller-report` commits
- [ ] template `testlogs-client-render` also carries the `index.md`→`index.html`
      swap — hold it until Phase 3

### Phase 1 — land the producers (main)

Merge order matters (GiellaLTLexTools before its callers):

1. [x] **giella-core** `docs: fix report.json recipe…` (`bbd4c2ab`, main).
   Inert for existing flows (the `report.json` target isn't reached by
   `make check` or the docs workflow); only `docs-publish` calls it.
2. [x] **GiellaLTLexTools** `json-output` (v0.10.0) → main, **pushed**.
   `divvun-actions` installs it with `uv pip install --upgrade git+…@main`
   on every build, so the next CI run has it. `-L` behaviour is byte-identical.
3. [ ] **template-lang-und** — `-J` in the 5 test `.sh.in` scripts (rev 333).
   Land this so `make check` starts writing `docs/testlogs/*-lemmas.json`.
   Test it in one repo first (apply the template change, `make check`, inspect
   the JSON) — see Phase 1.5.
4. [ ] **divvun-actions** `lang-docs-publish` → **PR with real review** (new
   prod CI behaviour + it writes GitHub releases and force-pushes a
   `docs-latest` tag to every lang repo). After merge, every `lang-` `main`
   build publishes `docs-latest`. Nothing consumes it yet.

### Phase 1.5 — prove `-J` in one repo

Before merging the divvun-actions PR: apply the template `.sh.in` change to one
repo (`gut template apply -r '^lang-sme$'`, or by hand), ensure
`gtlemmatest --version` is >= 0.10.0, run `make check`, and confirm
`docs/testlogs/*-lemmas.json` appear and parse. Feed one through
`actions/lang/testlogs.ts` (`deno test`, or a scratch script) to confirm the
manifest + per-suite output.

### Phase 2 — verify the releases (no repo changes)

Let `docs-latest` populate. Check a spread of repos:

| repo | why |
|---|---|
| `lang-sme` | healthy, spellers + grammar + dialects |
| `lang-nno` | tests badly broken (the `truncated` / large-file path) |
| `lang-smj` or another variant repo | dialect/area/alt-orth report variants |
| a small analyser-only repo | no speller → no `report.json` / speller badges |

For each: badge JSONs are valid shields endpoints; `testlogs.json` manifest +
`testlogs-<pos>.json` present and well-formed; `report.json` present and
non-empty (spellers only); `docs-latest` release + tag exist.

Fix the `TODO(CI)` items in `docs-publish.ts` (make target names, VPATH paths,
variant reports) as divvun-actions PRs — each fix re-publishes on the next
build. Stay in this phase until a handful of repos look right.

### Phase 3 — land the theme + canary the flip

4. [ ] **jekyll-theme-giellalt** `testlogs-client-render` → PR → main. Inert:
   `testlogs.js` only loads on a page that includes it, which no repo has yet.
5. [ ] Canary **`lang-sme`, `lang-nno`, one variant repo** — one hand-made
   commit each:
   - swap `docs/testlogs/index.md` → the new `index.html`
   - flip README + `docs/index-header.md` badge `url=` to
     `…/releases/download/docs-latest/…`
   - `git rm -r docs/badgedata` and `git rm docs/testlogs/*-lemmas.{md,json}`
   - **keep** `docs/typosreport/` (incl. `report.json`) — that waits for
     Phase 4
   - add `.gitignore` entries
   - Push, watch: Pages build green, README badges render, `/testlogs/` summary
     + expand works (incl. the broken `lang-nno` path).
   - **Soak 3–7 days.**

### Phase 4 — typos report viewer

6. [ ] **accuracy-viewer** (Workstream 4): `fetch()` `report.json` +
   `fst-variants.json` from the release URL; rebuild bundle; sync into the
   template; canary on the same three repos.
7. [ ] Once green, the canary repos drop `docs/typosreport/report*.json` too.

### Phase 5 — batch the flip to all 170

8. [ ] One `gut apply` script doing Phase 3's + Phase 4's per-repo edits.
   - skip any repo with no `docs-latest` release (report them; trigger a build)
   - bump each repo's `.gut/delta.toml`
   - `gut commit` + spot-check ~5 + `gut push`
9. [ ] Keep a **revert script** ready (restore files from `git`, restore badge
   URLs) — same shape as the rollout script.

### Phase 6 — cleanup

10. [ ] **giellalt/.github** (Workstream 7): the badge targets in `make -C docs`
    are now vestigial; drop them. Optional.
11. [ ] Once the JSON path is proven everywhere, consider dropping `-L`
    (markdown) from the test `.sh.in` scripts — the `-E` editor-open still
    works off a temp file. Keep it while local devs still open the `.md` logs.

## Rollback per phase

| phase | to undo |
|---|---|
| 0–2, 3-step-4 | revert the PR; next build/deploy is back to normal; stale releases are harmless |
| 3 canary, 4 | per-repo `git revert` restores the committed files + old badge URLs |
| 5 | run the revert script over `^lang-` |

## Verification checklist

- `docs-latest` release on a canary repo carries: badge `*.json`,
  `report.json` (spellers), `testlogs.json` + `testlogs-<pos>.json`.
- `https://img.shields.io/endpoint?url=…/releases/download/docs-latest/fst-maturity.json`
  renders.
- Canary Pages build green; `/testlogs/` summary loads instantly, a failing
  suite expands and fetches its file; `/typosreport/` loads (Phase 4+).
- `git clone --filter=blob:none` size of a canary repo stops growing
  build-over-build.
- Break a lemma test on a branch → merge → next `main` build's `docs-latest`
  and the live `/testlogs/` page reflect it, with no docs rebuild.

---

## Follow-ups / out of scope

- `corpus-` repos — same pattern, separate pass (needs a survey of what they
  generate and who consumes it).
- `keyboard` / `dict` / `speech` repo types — later.
- **`gut` cannot delete files** removed from a template's `required` list —
  template file removals always need a manual `git rm` pass. Raise with the
  `gut` maintainer.
- `gut template apply` is patch-based and fragile against any local divergence;
  never use it for bulk reformatting — use `gut apply` scripts.
- After the `speller-report` push, `.gut/delta.toml` sits at `rev 331` (=
  current template HEAD). Running `gut template apply` before the template
  advances to `rev 332` errors with `can't seem to find a patch` and needs
  `--abort`. Harmless; resolved once a real template change lands.

## Open questions

- Exact repo name for the `accuracy-viewer` Svelte source.
- Keep publishing Class 1 badges from the `docs.yml` build as a redundant
  path, or make Buildkite the sole publisher?
- Add a `gtlemmatest` version gate to giella-core's `configure.ac` (like the
  `divvunspell` one) so an agent with GiellaLTLexTools < 0.10.0 fails cleanly
  at configure rather than with an argparse error mid-`make check`?
