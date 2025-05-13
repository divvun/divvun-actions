import { Client, createClient, Schema } from "@openbao/api"
import { decodeBase64 } from "jsr:@std/encoding/base64"

type AppRoleLoginResponse = {
  auth: {
    client_token: string
  }
}

export class OpenBao {
  #client: Client

  static async fromServiceToken(
    endpoint: string,
    serviceToken: string,
  ): Promise<OpenBao> {
    const client = createClient<Schema>({
      endpoint: `${endpoint}/v1`,
      plugins: [
        {
          onRequestInit: ({ requestInit }) => {
            requestInit.headers = {
              ...requestInit.headers,
              Authorization: `Bearer ${serviceToken}`,
            }
          },
        },
      ],
    })

    const roleResponse =
      await client["/auth/{approle_mount_path}/role/{role_name}/role-id"].get({
        params: {
          approle_mount_path: "approle",
          role_name: "builder",
        },
      }).json()
    const secretResponse =
      await client["/auth/{approle_mount_path}/role/{role_name}/secret-id"]
        .post({
          params: {
            approle_mount_path: "approle",
            role_name: "builder",
          },
          json: {},
        }).json()

    console.log(roleResponse, roleResponse.data)

    const { role_id: roleId } = roleResponse?.data
    const { secret_id: roleSecret } = secretResponse?.data

    if (endpoint == null || roleId == null || roleSecret == null) {
      throw new Error("OpenBao endpoint, roleId or roleSecret not found")
    }

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

    if (json?.auth?.client_token == null) {
      console.error(json)
      throw new Error("OpenBao client token not found")
    }

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
    return new SecretsStore(json.data.data)
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
