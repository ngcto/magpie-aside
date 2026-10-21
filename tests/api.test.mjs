import { expect, test } from "bun:test"
import { createApi } from "../src/api.mjs"

function slowServer() {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ready":'))
      const timer = setTimeout(() => { try { controller.enqueue(new TextEncoder().encode('true}')); controller.close() } catch {} }, 100)
      timer.unref?.()
    } }), { headers: { "content-type": "application/json" } })
  } })
}

test("a response-header deadline cannot truncate a progressing response body", async () => {
  const server = slowServer()
  try {
    const api = createApi({ baseURL: server.url.href })
    const response = await api.request("/stream", { timeoutMs: 50 })
    expect(await response.json()).toEqual({ ready: true })
  } finally { server.stop(true) }
})

test("image-style full-operation timeouts still bound JSON body consumption", async () => {
  const server = slowServer()
  try {
    const api = createApi({ baseURL: server.url.href })
    const error = await api.json("/image", { timeoutMs: 50, timeoutScope: "body", retry: 0 }).catch((error) => error)
    expect(error.status).toBe(504)
    expect(error.code).toBe("ASIDE_API_TIMEOUT")
  } finally { server.stop(true) }
})

test("caller cancellation remains active after response headers have arrived", async () => {
  const server = slowServer()
  try {
    const api = createApi({ baseURL: server.url.href })
    const controller = new AbortController()
    const response = await api.request("/stream", { timeoutMs: 50, signal: controller.signal })
    controller.abort(new DOMException("Cancelled", "AbortError"))
    const result = await response.text().catch((error) => error)
    expect(result.name).toBe("AbortError")
  } finally { server.stop(true) }
})
