// deno-lint-ignore-file no-console
import { versions } from "./versions.ts"

type Check = {
  label: string
  pinned: string
  repo: string
  /** Strip a leading 'v' or other prefix from the release tag. Defaults to stripping 'v'. */
  tagToVersion?: (tag: string) => string
}

const defaultStrip = (tag: string) => tag.startsWith("v") ? tag.slice(1) : tag

const checks: Check[] = [
  {
    label: "openbao",
    pinned: versions.openbao,
    repo: "openbao/openbao",
  },
  {
    label: "gh",
    pinned: versions.gh,
    repo: "cli/cli",
  },
  {
    label: "minisign",
    pinned: versions.minisign,
    repo: "jedisct1/minisign",
    tagToVersion: (t) => t,
  },
  {
    label: "just",
    pinned: versions.just,
    repo: "casey/just",
  },
  {
    label: "divvun-runtime",
    pinned: versions.divvunRuntime,
    repo: "divvun/divvun-runtime",
  },
  {
    label: "cmake",
    pinned: versions.cmake,
    repo: "Kitware/CMake",
  },
  {
    label: "ninja",
    pinned: versions.ninja,
    repo: "ninja-build/ninja",
  },
  {
    label: "powershell",
    pinned: versions.powershellCore,
    repo: "PowerShell/PowerShell",
  },
  {
    label: "git-for-windows",
    pinned: versions.gitForWindows,
    repo: "git-for-windows/git",
    // release tags look like `v2.47.1.windows.1` — keep the full thing after 'v'
  },
]

type Result = {
  label: string
  pinned: string
  latest: string
  drift: boolean
  repo: string
  error?: string
}

async function fetchLatest(repo: string): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`
  const headers: HeadersInit = { "Accept": "application/vnd.github+json" }
  const token = Deno.env.get("GITHUB_TOKEN")
  if (token) headers["Authorization"] = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  const body = await res.json()
  const tag = body.tag_name as string | undefined
  if (!tag) throw new Error(`no tag_name in response`)
  return tag
}

async function run() {
  const results: Result[] = []
  for (const c of checks) {
    try {
      const tag = await fetchLatest(c.repo)
      const latest = (c.tagToVersion ?? defaultStrip)(tag)
      results.push({
        label: c.label,
        pinned: c.pinned,
        latest,
        drift: latest !== c.pinned,
        repo: c.repo,
      })
    } catch (err) {
      results.push({
        label: c.label,
        pinned: c.pinned,
        latest: "?",
        drift: false,
        repo: c.repo,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const pad = (s: string, n: number) =>
    s + " ".repeat(Math.max(0, n - s.length))
  console.log(
    pad("tool", 20) + pad("pinned", 20) + pad("latest", 20) + "status",
  )
  console.log("─".repeat(80))
  let drifted = 0
  for (const r of results) {
    let status = "ok"
    if (r.error) status = `ERR ${r.error}`
    else if (r.drift) {
      status = `drift → https://github.com/${r.repo}/releases/tag/${r.latest}`
      drifted++
    }
    console.log(
      pad(r.label, 20) + pad(r.pinned, 20) + pad(r.latest, 20) + status,
    )
  }
  console.log()
  if (drifted > 0) {
    console.log(
      `${drifted} tool(s) behind. Update in docker/versions.ts and run deno task docker:gen.`,
    )
  } else {
    console.log(`All tracked tools up to date.`)
  }
  if (!Deno.env.get("GITHUB_TOKEN")) {
    console.log(
      `\nHint: export GITHUB_TOKEN to avoid rate limits (60 req/hr unauthenticated).`,
    )
  }
}

if (import.meta.main) {
  await run()
}
