import { Client, createClient, Schema } from "@openbao/api"
import { decodeBase64 } from "jsr:@std/encoding/base64"

type AppRoleLoginResponse = {
  auth: {
    client_token: string
  }
}

export class OpenBao {
  #client: Client

  static async fromMetadata(getter: (key: string) => Promise<string>): Promise<OpenBao> {
    const endpoint = await getter("divvun_actions_openbao_endpoint")
    const roleId = await getter("divvun_actions_openbao_role_id")
    const roleSecret = await getter("divvun_actions_openbao_role_secret")

    return OpenBao.fromAppRole(endpoint, roleId, roleSecret)
  }

  static async fromAppRole(
    endpoint: string,
    roleId: string,
    roleSecret: string,
  ): Promise<OpenBao> {
    const client = createClient<Schema>({
      endpoint: `${endpoint}/v1`,
    })
    const response = await client["/auth/{approle_mount_path}/login"].post({
      params: {
        approle_mount_path: "approle",
      },
      json: {
        role_id: roleId,
        secret_id: roleSecret,
      },
    })
    const json = await response.json() as AppRoleLoginResponse

    return new OpenBao(endpoint, json.auth.client_token)
  }

  constructor(endpoint: string, token: string) {
    this.#client = createClient<Schema>({
      endpoint: `${endpoint}/v1`,
      plugins: [
        {
          onRequestInit: ({ requestInit }) => {
            requestInit.headers = {
              ...requestInit.headers,
              Authorization: `Bearer ${token}`,
            }
          },
        },
      ],
    })
  }

  async secrets(): Promise<SecretsStore> {
    const response = await (this.#client as any)["/ci/data/build"].get()
    const json = await response.json()
    return new SecretsStore(json.data)
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
    const value = this.#map.get(key)
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
}
