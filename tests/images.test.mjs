import { describe, expect, test } from "bun:test"
import { AsideApiError, createApi } from "../src/api.mjs"
import { handleImageRequest } from "../src/images.mjs"

// Real one-pixel PNG, JPEG, and WebP files, encoded by ImageMagick.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEX/AAAZ4gk3AAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg=="
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ADkD03v/2Q=="
const WEBP = "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoBAAEAAgA0JaACdLoAA5gA/vmTb/+QH/+QH/+QH/8gP+IXeyAwAA=="
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
const MODEL = "gemini-3.1-flash-image"
const catalog = { provider: "aside", models: [], imageModels: [{ id: MODEL, name: "Nano Banana 2" }] }
const url = (path) => `https://gateway.example/ai/v1${path}`
const dataURL = (data, mime = "image/png") => `data:${mime};base64,${data}`
const image = (data = PNG, mimeType = "image/png") => ({ type: "image", data, mimeType })
const native = (...images) => ({ model: MODEL, images: images.length ? images : [image()] })

function scripted(...results) {
  if (!results.length) results = [native()]
  const calls = []
  return {
    calls,
    async json(path, options) {
      calls.push({ path, ...options })
      const result = results.shift()
      if (result instanceof Error) throw result
      if (result === undefined) throw new Error("Unexpected additional native image generation")
      return result
    },
  }
}

function generate(body, account = scripted(), path = "/images/generations", extraInit = {}) {
  const multipart = body instanceof FormData
  return handleImageRequest(url(path), {
    method: "POST", ...(multipart ? {} : { headers: { "content-type": "application/json" } }),
    body: multipart ? body : JSON.stringify({ model: MODEL, ...body }), ...extraInit,
  }, { account, catalog })
}

function chat(body, account = scripted(), extraInit) {
  return generate({ messages: [{ role: "user", content: "Draw a cat" }], ...body }, account, "/chat/completions", extraInit)
}

describe("Aside image input validation", () => {
  test("uses parent-parsed JSON from an already-consumed Request without touching its body again", async () => {
    const request = new Request(url("/images/edits"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt: "Edit", image: dataURL(PNG) }),
    })
    const body = await request.json()
    expect(request.bodyUsed).toBe(true)
    const account = scripted(native(image(WEBP, "image/webp")))
    const response = await handleImageRequest(request, undefined, { account, catalog, body })
    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual([{ b64_json: WEBP, media_type: "image/webp" }])
    expect(account.calls[0].body.inputImages).toEqual([{ data: PNG, mimeType: "image/png" }])
  })

  test("preserves the original consumed Request's cancellation signal with a parsed body", async () => {
    const controller = new AbortController()
    const request = new Request(url("/images/generations"), {
      method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ model: MODEL, prompt: "Draw" }),
    })
    const body = await request.json()
    const reason = new DOMException("Cancelled after parsing", "AbortError")
    controller.abort(reason)
    const unused = scripted()
    await expect(handleImageRequest(request, undefined, { account: unused, catalog, body })).rejects.toBe(reason)
    expect(unused.calls).toHaveLength(0)
  })

  test("trims prompts before enforcing the exact UTF-16 character boundary", async () => {
    const account = scripted()
    const accepted = await generate({ prompt: ` \n${"😀".repeat(16000)}\n ` }, account)
    expect(accepted.status).toBe(200)
    expect(account.calls[0].body.prompt).toBe("😀".repeat(16000))
    for (const prompt of [" \n ", "😀".repeat(16001), "x".repeat(32001)]) {
      const unused = scripted()
      const rejected = await generate({ prompt }, unused)
      expect(rejected.status).toBe(400)
      expect((await rejected.json()).error.code).toBe("invalid_image_prompt")
      expect(unused.calls).toHaveLength(0)
    }
  })

  test("normalizes data-URL whitespace and derives reference MIME from bytes, not claims", async () => {
    const account = scripted()
    const spaced = PNG.match(/.{1,20}/g).join("\n")
    const response = await generate({ prompt: " edit ", inputImages: [
      { data: WEBP, mimeType: "image/png" }, dataURL(spaced, "image/jpeg"),
    ] }, account)
    expect(response.status).toBe(200)
    expect(account.calls[0].body.inputImages).toEqual([
      { data: WEBP, mimeType: "image/webp" }, { data: PNG, mimeType: "image/png" },
    ])
  })

  test("accepts Magpie JSON URL-object references for edits", async () => {
    const account = scripted()
    const response = await generate({ prompt: "Turn it blue", images: { image_url: dataURL(JPEG, "image/webp") } }, account, "/images/edits")
    expect(response.status).toBe(200)
    expect(account.calls[0].body.inputImages).toEqual([{ data: JPEG, mimeType: "image/jpeg" }])
  })

  test("accepts multipart image[] files without trusting filename or content type", async () => {
    const form = new FormData()
    form.append("model", MODEL)
    form.append("prompt", "Combine these")
    form.append("image[]", new Blob([Buffer.from(JPEG, "base64")], { type: "image/gif" }), "misleading.gif")
    form.append("image[]", new Blob([Buffer.from(WEBP, "base64")], { type: "application/octet-stream" }), "unknown.bin")
    const account = scripted()
    const response = await generate(form, account, "/images/edits")
    expect(response.status).toBe(200)
    expect(account.calls[0].body.inputImages).toEqual([
      { data: JPEG, mimeType: "image/jpeg" }, { data: WEBP, mimeType: "image/webp" },
    ])
  })

  test("accepts 16 references and rejects 17 before authenticated work", async () => {
    const references = Array.from({ length: 16 }, () => ({ data: PNG, mimeType: "image/png" }))
    expect((await generate({ prompt: "Combine", inputImages: references })).status).toBe(200)
    const unused = scripted()
    const response = await generate({ prompt: "Combine", inputImages: [...references, references[0]] }, unused)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("too_many_reference_images")
    expect(unused.calls).toHaveLength(0)
  })

  test("limits the aggregate decoded reference bytes, not the larger base64 payload", async () => {
    // Padding after the real PNG's IEND keeps the image's type while exercising byte accounting.
    const tenMiB = Buffer.alloc(10 * 1024 * 1024)
    Buffer.from(PNG, "base64").copy(tenMiB)
    const reference = { data: tenMiB.toString("base64"), mimeType: "image/png" }
    expect((await generate({ prompt: "Use both", inputImages: [reference, reference] })).status).toBe(200)
    const oneByteLarger = { data: Buffer.concat([tenMiB, Buffer.alloc(1)]).toString("base64"), mimeType: "image/png" }
    const unused = scripted()
    const response = await generate({ prompt: "Use both", inputImages: [reference, oneByteLarger] }, unused)
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("reference_images_too_large")
    expect(unused.calls).toHaveLength(0)
  })

  test.each([
    ["malformed base64", "%%%not-base64%%%", "invalid_reference_image"],
    ["unpadded base64", "AAAAA", "invalid_reference_image"],
    ["non-image bytes", Buffer.from("not an image").toString("base64"), "unsupported_reference_image"],
    ["GIF bytes claiming PNG", dataURL(GIF), "unsupported_reference_image"],
    ["JPEG-LS signature", Buffer.from([255, 216, 255, 247]).toString("base64"), "unsupported_reference_image"],
  ])("rejects %s rather than trusting a MIME label", async (_name, reference, code) => {
    const unused = scripted()
    const response = await generate({ prompt: "Edit", image: reference }, unused, "/images/edits")
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe(code)
    expect(unused.calls).toHaveLength(0)
  })

  test("rejects remote image references without initiating authenticated work", async () => {
    const unused = scripted()
    const response = await generate({ prompt: "Edit", image: "https://external.example/private.png" }, unused, "/images/edits")
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("external_reference_url_unsupported")
    expect(unused.calls).toHaveLength(0)
  })

  test("requires an edit reference instead of silently treating an edit as generation", async () => {
    const unused = scripted()
    const response = await generate({ prompt: "Edit" }, unused, "/images/edits")
    expect(response.status).toBe(400)
    expect((await response.json()).error.code).toBe("reference_image_required")
    expect(unused.calls).toHaveLength(0)
  })

  test.each([
    ["size", "1024x1024"], ["quality", "high"], ["background", "transparent"],
    ["output_format", "webp"], ["mask", dataURL(PNG)], ["style", "vivid"],
  ])("makes unsupported %s intent an explicit error", async (option, value) => {
    const unused = scripted()
    const response = await generate({ prompt: "Draw", [option]: value }, unused)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({ code: "unsupported_image_option", param: option })
    expect(unused.calls).toHaveLength(0)
  })

  test("does not silently discard multipart masks", async () => {
    const form = new FormData()
    form.append("model", MODEL)
    form.append("prompt", "Edit")
    form.append("image", new Blob([Buffer.from(PNG, "base64")]), "image.png")
    form.append("mask", new Blob([Buffer.from(PNG, "base64")]), "mask.png")
    const unused = scripted()
    const response = await generate(form, unused, "/images/edits")
    expect(response.status).toBe(400)
    expect((await response.json()).error.param).toBe("mask")
    expect(unused.calls).toHaveLength(0)
  })

  test.each([0, -1, 1.5, 11, "2"])("rejects unsupported n=%s instead of dropping it", async (n) => {
    const unused = scripted()
    expect((await generate({ prompt: "Draw", n }, unused)).status).toBe(400)
    expect(unused.calls).toHaveLength(0)
  })
})

describe("Aside image result boundaries", () => {
  test("preserves every returned PNG, JPEG, and WebP with its real MIME and bytes", async () => {
    const account = scripted(native(image(PNG, "image/jpeg"), image(JPEG, "image/png"), image(WEBP)))
    const response = await generate({ prompt: "Draw", size: "auto", quality: "auto", background: "auto" }, account)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.data).toEqual([
      { b64_json: PNG, media_type: "image/png" }, { b64_json: JPEG, media_type: "image/jpeg" }, { b64_json: WEBP, media_type: "image/webp" },
    ])
    expect(body).not.toHaveProperty("usage")
  })

  test("URL responses are real inline data URLs, not invented hosted URLs", async () => {
    const response = await generate({ prompt: "Draw", response_format: "url" }, scripted(native(image(WEBP, "image/png"))))
    expect((await response.json()).data).toEqual([{ url: dataURL(WEBP, "image/webp"), media_type: "image/webp" }])
  })

  test("n performs the requested generations and never truncates native image arrays", async () => {
    const account = scripted(native(image(PNG), image(JPEG, "image/jpeg")), native(image(WEBP, "image/webp")))
    const response = await generate({ prompt: "Draw", n: 2 }, account)
    expect(response.status).toBe(200)
    expect((await response.json()).data.map((entry) => entry.b64_json)).toEqual([PNG, JPEG, WEBP])
    expect(account.calls).toHaveLength(2)
  })

  test.each([
    ["no images", { model: MODEL, images: [] }],
    ["malformed base64", native(image("%%%="))],
    ["unsupported actual image", native(image(GIF))],
    ["unsupported declared image", native(image(PNG, "image/gif"))],
    ["wrong content type", { model: MODEL, images: [{ type: "text", data: PNG, mimeType: "image/png" }] }],
  ])("reports %s as an upstream result error", async (_name, result) => {
    const response = await generate({ prompt: "Draw" }, scripted(result))
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe("invalid_image_response")
  })

  test.each([401, 402, 429, 504])("retains upstream status %s and its diagnostic code", async (status) => {
    const response = await generate({ prompt: "Draw" }, scripted(new AsideApiError(status, "Actual Aside diagnostic", "ACTUAL_ASIDE_CODE")))
    expect(response.status).toBe(status)
    expect((await response.json()).error).toMatchObject({ message: "Actual Aside diagnostic", code: "ACTUAL_ASIDE_CODE" })
  })

  test("does not retry a transient image-generation failure through the general JSON helper", async () => {
    let attempts = 0
    let sleeps = 0
    const api = createApi({
      baseURL: "https://aside.example",
      fetchImpl: async () => { attempts++; return new Response(JSON.stringify({ code: "BUSY", message: "Busy" }), { status: 503 }) },
      sleep: async () => { sleeps++ },
    })
    const response = await generate({ prompt: "Draw" }, { json: api.json })
    expect(response.status).toBe(503)
    expect(attempts).toBe(1)
    expect(sleeps).toBe(0)
  })

  test("returns a later generation failure instead of claiming partial n success", async () => {
    const account = scripted(native(), new AsideApiError(402, "No credits remain", "INSUFFICIENT_CREDITS"))
    const response = await generate({ prompt: "Draw", n: 3 }, account)
    expect(response.status).toBe(402)
    expect(await response.json()).not.toHaveProperty("data")
    expect(account.calls).toHaveLength(2)
  })

  test("caller cancellation rejects and stops remaining requested generations", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Image generation cancelled", "AbortError")
    let started
    const ready = new Promise((resolve) => { started = resolve })
    let attempts = 0
    const api = createApi({ baseURL: "https://aside.example", fetchImpl: (_url, { signal }) => {
      attempts++
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        started()
      })
    } })
    const pending = generate({ prompt: "Draw", n: 3 }, { json: api.json }, "/images/generations", { signal: controller.signal })
    const rejected = pending.catch((error) => error)
    await ready
    controller.abort(reason)
    expect(await rejected).toBe(reason)
    expect(attempts).toBe(1)
  })
})

describe("Magpie nonstreaming Chat drawing", () => {
  test("accepts Magpie's image/text modalities and produces its data-URL image result", async () => {
    const account = scripted(native(image(JPEG, "image/png"), image(WEBP, "image/webp")))
    const response = await chat({
      stream: false, modalities: ["image", "text"],
      messages: [{ role: "user", content: [
        { type: "text", text: " Turn this red " }, { type: "image_url", image_url: { url: dataURL(PNG), detail: "auto" } },
      ] }],
    }, account)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.model).toBe(MODEL)
    expect(body.choices[0].message.images.map((entry) => entry.image_url.url)).toEqual([dataURL(JPEG, "image/jpeg"), dataURL(WEBP, "image/webp")])
    expect(body.choices[0].finish_reason).toBe("stop")
    expect(body).not.toHaveProperty("usage")
    expect(account.calls[0].body.inputImages).toEqual([{ data: PNG, mimeType: "image/png" }])
  })

  test("honors Chat n as separate image-producing choices", async () => {
    const response = await chat({ n: 2 }, scripted(native(image(PNG)), native(image(WEBP, "image/webp"))))
    const body = await response.json()
    expect(body.choices.map((choice) => [choice.index, choice.message.images[0].image_url.url])).toEqual([
      [0, dataURL(PNG)], [1, dataURL(WEBP, "image/webp")],
    ])
  })

  test("rejects Chat streaming with an actionable Images endpoint error", async () => {
    const unused = scripted()
    const response = await chat({ stream: true }, unused)
    expect(response.status).toBe(400)
    const error = (await response.json()).error
    expect(error.code).toBe("image_streaming_unsupported")
    expect(error.message).toContain("/images/generations")
    expect(unused.calls).toHaveLength(0)
  })

  test("does not ignore a Chat-only rendering option", async () => {
    const unused = scripted()
    const response = await chat({ image_config: { aspect_ratio: "16:9" } }, unused)
    expect(response.status).toBe(400)
    expect((await response.json()).error.param).toBe("image_config")
    expect(unused.calls).toHaveLength(0)
  })
})
