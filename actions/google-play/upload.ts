import { encodeBase64 } from "@std/encoding/base64"
import logger from "~/util/log.ts"

export interface GooglePlayUploadOptions {
  serviceAccountJson: string
  packageName: string
  aabPath: string
  track?: "internal" | "alpha" | "beta" | "production"
  releaseStatus?: "draft" | "completed" | "halted" | "inProgress"
}

export async function googlePlayUpload(options: GooglePlayUploadOptions) {
  const {
    serviceAccountJson,
    packageName,
    aabPath,
    track = "internal",
    releaseStatus = "completed",
  } = options

  const token = await getAccessToken(serviceAccountJson)
  const api =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${packageName}`

  async function apiCall(url: string, init?: RequestInit) {
    const resp = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init?.headers },
    })
    if (!resp.ok) {
      throw new Error(
        `Google Play API error: ${resp.status} ${await resp.text()}`,
      )
    }
    return resp.json()
  }

  // Create edit
  const edit = await apiCall(`${api}/edits`, { method: "POST" })
  logger.info(`Created edit: ${edit.id}`)

  // Upload AAB
  const aabData = await Deno.readFile(aabPath)
  const bundle = await apiCall(
    `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${packageName}/edits/${edit.id}/bundles?uploadType=media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: aabData,
    },
  )
  logger.info(`Uploaded AAB: version code ${bundle.versionCode}`)

  // Assign to track
  await apiCall(`${api}/edits/${edit.id}/tracks/${track}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      track,
      releases: [{
        versionCodes: [bundle.versionCode],
        status: releaseStatus,
      }],
    }),
  })
  logger.info(`Assigned to ${track} track`)

  // Commit
  await apiCall(`${api}/edits/${edit.id}:commit`, { method: "POST" })
  logger.info("Edit committed — upload complete")
}

async function getAccessToken(
  serviceAccountJson: string,
): Promise<string> {
  const sa = JSON.parse(serviceAccountJson)
  const now = Math.floor(Date.now() / 1000)

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const claims = base64Url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }))

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "")

  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const sig = base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ),
  )

  const resp = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${sig}`,
    }),
  })

  if (!resp.ok) {
    throw new Error(
      `Failed to get access token: ${resp.status} ${await resp.text()}`,
    )
  }
  return (await resp.json()).access_token
}

function base64Url(input: string | Uint8Array): string {
  const data = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input
  return encodeBase64(data)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}
