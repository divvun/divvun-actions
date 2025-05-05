/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { assertEquals } from "jsr:@std/assert"
import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd"
import serve from "./windows-codesign.ts"

describe("Windows Code Signing Server", () => {
  const testPort = 8123
  const testHost = "127.0.0.1"
  const baseUrl = `http://${testHost}:${testPort}`
  let controller: AbortController
  let server: any

  async function waitForServer() {
    for (let i = 0; i < 10; i++) {
      try {
        const response = await fetch(baseUrl)
        if (response.status === 405) { // Method not allowed means server is up
          await response.text() // Consume the response body
          return
        }
        await response.text() // Consume the response body even if status is not 405
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    throw new Error("Server failed to start")
  }

  beforeEach(async () => {
    controller = new AbortController()
    server = serve(testPort, testHost, controller.signal)
    await waitForServer()
  })

  afterEach(async () => {
    controller.abort()
    try {
      await server.finished
    } catch (error: unknown) {
      // Ignore abort errors
      if (error instanceof Error && !error.message.includes("aborted")) {
        throw error
      }
    }
    // Give the server time to fully close
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  it("should accept binary data and return signed binary", async () => {
    const testBinary = new Uint8Array([1, 2, 3, 4])
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: testBinary,
    })

    assertEquals(response.status, 200)
    assertEquals(response.headers.get("content-type"), "application/octet-stream")
    
    const responseData = new Uint8Array(await response.arrayBuffer())
    // For now, we know it returns 4 bytes of 0x42 as per the TODO implementation
    assertEquals(responseData, new Uint8Array([0x42, 0x42, 0x42, 0x42]))
  })

  it("should reject non-POST requests", async () => {
    const response = await fetch(baseUrl, {
      method: "GET",
    })

    assertEquals(response.status, 405)
    assertEquals(await response.text(), "Method not allowed")
  })

  it("should reject requests with wrong content type", async () => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ test: "data" }),
    })

    assertEquals(response.status, 400)
    assertEquals(
      await response.text(),
      "Invalid content type. Expected application/octet-stream",
    )
  })

  it("should reject empty binary data", async () => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
      },
      body: new Uint8Array(),
    })

    assertEquals(response.status, 400)
    assertEquals(await response.text(), "Empty binary data")
  })
}) 