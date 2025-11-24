import { retry } from "@std/async/retry"

/**
 * Wrapper around fetch for GitHub API calls with automatic retry on failures.
 * Handles rate limiting (429) and other transient errors with exponential backoff.
 */
export async function fetchGithub(
  url: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return retry(
    () =>
      fetch(url, {
        ...options,
        headers: {
          "Authorization": `token ${token}`,
          "Accept": "application/vnd.github.v3+json",
          ...options?.headers,
        },
      }).then((r) => {
        if (r.status === 429) {
          throw new Error("Rate limited")
        }
        if (!r.ok && r.status !== 404) {
          throw new Error(`HTTP ${r.status}: ${r.statusText}`)
        }
        return r
      }),
    {
      maxAttempts: 3,
      minTimeout: 1000,
      multiplier: 2,
      jitter: 0.2,
    },
  )
}

/**
 * Wrapper around fetch for Buildkite API calls with automatic retry on failures.
 * Handles rate limiting (429) and other transient errors with exponential backoff.
 */
export async function fetchBuildkite(
  url: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return retry(
    () =>
      fetch(url, {
        ...options,
        headers: {
          "Authorization": `Bearer ${token}`,
          ...options?.headers,
        },
      }).then((r) => {
        if (r.status === 429) {
          throw new Error("Rate limited")
        }
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}: ${r.statusText}`)
        }
        return r
      }),
    {
      maxAttempts: 3,
      minTimeout: 1000,
      multiplier: 2,
      jitter: 0.2,
    },
  )
}
