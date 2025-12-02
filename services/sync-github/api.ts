class RateLimitError extends Error {
  resetTime: number
  constructor(resetTime: number) {
    const waitSeconds = Math.max(0, resetTime - Math.floor(Date.now() / 1000))
    super(`Rate limited, resets in ${waitSeconds}s`)
    this.resetTime = resetTime
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wrapper around fetch for GitHub API calls with automatic retry on failures.
 * Handles rate limiting using x-ratelimit headers and waits for reset.
 */
export async function fetchGithub(
  url: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  const maxAttempts = 5

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `token ${token}`,
        "Accept": "application/vnd.github.v3+json",
        ...options?.headers,
      },
    })

    // Check for rate limiting (403 or 429 with x-ratelimit-remaining: 0)
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining")
      const resetTime = response.headers.get("x-ratelimit-reset")

      if (remaining === "0" && resetTime && attempt < maxAttempts) {
        const resetTimestamp = parseInt(resetTime)
        const waitMs =
          Math.max(0, (resetTimestamp - Math.floor(Date.now() / 1000)) * 1000) +
          1000
        console.log(
          `⏳ Rate limited, waiting ${Math.ceil(waitMs / 1000)}s for reset...`,
        )
        await sleep(waitMs)
        continue
      }

      if (remaining === "0") {
        throw new RateLimitError(resetTime ? parseInt(resetTime) : 0)
      }
    }

    if (!response.ok && response.status !== 404) {
      if (attempt < maxAttempts) {
        const waitMs = 1000 * Math.pow(2, attempt - 1)
        await sleep(waitMs)
        continue
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return response
  }

  throw new Error(`Failed after ${maxAttempts} attempts`)
}

/**
 * Wrapper around fetch for Buildkite API calls with automatic retry on failures.
 * Handles rate limiting using RateLimit-Reset header (seconds until reset).
 */
export async function fetchBuildkite(
  url: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  const maxAttempts = 5

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${token}`,
        ...options?.headers,
      },
    })

    // Check for rate limiting (429 with RateLimit-Reset header)
    if (response.status === 429) {
      const resetSeconds = response.headers.get("RateLimit-Reset")

      if (resetSeconds && attempt < maxAttempts) {
        const waitMs = (parseInt(resetSeconds) + 1) * 1000
        console.log(
          `⏳ Buildkite rate limited, waiting ${resetSeconds}s for reset...`,
        )
        await sleep(waitMs)
        continue
      }

      throw new Error(
        `Buildkite rate limited, resets in ${resetSeconds || "?"}s`,
      )
    }

    if (!response.ok) {
      if (attempt < maxAttempts) {
        const waitMs = 1000 * Math.pow(2, attempt - 1)
        await sleep(waitMs)
        continue
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return response
  }

  throw new Error(`Failed after ${maxAttempts} attempts`)
}
