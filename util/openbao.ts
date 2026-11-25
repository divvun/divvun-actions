import { Client, createClient, Schema } from "@openbao/api"
import { decodeBase64 } from "@std/encoding/base64"

export class OpenBao {
  #client: Client

  /** When the login's token expires, in milliseconds since the epoch. */
  readonly expiresAt: number

  /**
   * Logs in to the JWT auth method mounted at `mount` as `role`, with `jwt`,
   * such as a Buildkite job's OIDC token.
   */
  static async fromJwt(
    endpoint: string,
    mount: string,
    role: string,
    jwt: string,
  ): Promise<OpenBao> {
    const response = await fetch(`${endpoint}/v1/auth/${mount}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, jwt }),
    })
    const json = await response.json().catch(() => null)
    const token = json?.auth?.client_token
    if (typeof token !== "string" || token === "") {
      const errors = Array.isArray(json?.errors)
        ? `: ${json.errors.join(", ")}`
        : ""
      throw new Error(
        `OpenBao refused the login as ${role} (HTTP ${response.status})${errors}`,
      )
    }
    return new OpenBao(
      endpoint,
      token,
      Date.now() + json.auth.lease_duration * 1000,
    )
  }

  constructor(endpoint: string, token: string, expiresAt: number) {
    this.expiresAt = expiresAt
    this.#client = createClient<Schema>({
      endpoint: `${endpoint}/v1`,
      plugins: [
        {
          onRequestInit: ({ requestInit }) => {
            Object.assign(requestInit, {
              headers: {
                ...(requestInit as { headers?: Record<string, string> })
                  .headers,
                Authorization: `Bearer ${token}`,
              },
            })
          },
        },
      ],
    })
  }

  async secrets(): Promise<SecretsStore> {
    const response = await (this.#client as any)["/ci/data/build"].get()
    const json = await response.json()
    return new SecretsStore(json.data.data)
  }

  /** The fields of one entry of the ci mount other than build. */
  async entry(name: string): Promise<Record<string, string>> {
    const response = await (this.#client as any)[`/ci/data/${name}`].get()
    const json = await response.json()
    const data = json?.data?.data
    if (data == null) {
      throw new Error(`OpenBao has no entry ci/${name}`)
    }
    return data
  }

  /**
   * An identity token OpenBao signs for its identity engine's role `role`,
   * such as Pahkat's publisher token from `pahkat-main`.
   */
  async identityToken(role: string): Promise<string> {
    const response = await (this.#client as any)[
      `/identity/oidc/token/${role}`
    ].get()
    const json = await response.json()
    const token = json?.data?.token
    if (typeof token !== "string" || token === "") {
      const errors = Array.isArray(json?.errors)
        ? `: ${json.errors.join(", ")}`
        : ""
      throw new Error(`OpenBao gave no identity token for ${role}${errors}`)
    }
    return token
  }
}

export class SecretsStore {
  #map: Map<string, string>

  constructor(data: Record<string, string>) {
    this.#map = new Map(Object.entries(data))
  }

  base64String(key: string) {
    const textDecoder = new TextDecoder()
    return textDecoder.decode(this.base64ByteArray(key))
  }

  base64ByteArray(key: string) {
    const value = this.#map.get(key)?.trim()?.replace(/\n/g, "")
    if (value == null) {
      throw new Error(`Secret '${key}' not found`)
    }
    return decodeBase64(value)
  }

  get(key: string) {
    const value = this.#map.get(key)
    if (value == null) {
      throw new Error(`Secret '${key}' not found`)
    }
    return value
  }

  entries() {
    return this.#map.entries()
  }

  values() {
    return this.#map.values()
  }

  keys() {
    return this.#map.keys()
  }

  only(keys: readonly string[]): SecretsStore {
    const data: Record<string, string> = {}
    for (const key of keys) {
      data[key] = this.get(key)
    }
    return new SecretsStore(data)
  }
}
