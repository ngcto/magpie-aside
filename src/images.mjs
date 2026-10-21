import { randomUUID } from "node:crypto"
import { AsideApiError } from "./api.mjs"
import { isImageModel } from "./catalog.mjs"

const MAX_PROMPT_LENGTH = 32000
const MAX_REFERENCE_IMAGES = 16
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const SNIFF_BYTES = 4100
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const IMAGE_FIELDS = new Set([
  "model", "prompt", "image", "images", "inputImages", "n", "response_format",
  "size", "quality", "background",
])
const CHAT_FIELDS = new Set(["model", "messages", "stream", "n", "modalities"])

class ImageRequestError extends Error {
  constructor(status, message, code, param = null) {
    super(message)
    this.status = status
    this.code = code
    this.param = param
  }
}

function invalid(message, param, code = "invalid_image_request") {
  throw new ImageRequestError(400, message, code, param)
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function unsupportedFields(value, allowed, prefix = "") {
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null || allowed.has(key)) continue
    const param = `${prefix}${key}`
    invalid(`Aside image generation does not support '${param}'.`, param, "unsupported_image_option")
  }
}

function imagePath(path) {
  const value = path instanceof Request ? path.url : String(path)
  return new URL(value, "http://aside.invalid").pathname.replace(/\/$/, "")
}

export function isImageRequest(path, body, catalog) {
  const pathname = imagePath(path)
  if (/\/images\/(generations|edits)$/.test(pathname)) return true
  const current = typeof catalog?.peek === "function" ? catalog.peek() : catalog
  return pathname.endsWith("/chat/completions") && isImageModel(current, body?.model)
}

// This is a type sniff, not a full image decoder. Aside sniffs the first 4,100 bytes.
function sniffMime(bytes) {
  bytes = bytes.subarray(0, SNIFF_BYTES)
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return bytes[3] === 247 ? null : "image/jpeg"
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp"
  }
  if (bytes.length < 16 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  let offset = 8
  let header = false
  do {
    const length = bytes.readInt32BE(offset)
    const type = bytes.toString("ascii", offset + 4, offset + 8)
    if (length < 0) return null
    if (type === "IHDR") {
      if (length !== 13) return null
      header = true
    }
    if (type === "IDAT") return "image/png"
    if (type === "acTL") return null
    if (!header && type !== "CgBI") return null
    offset += length + 12
  } while (offset + 8 < bytes.length)
  return "image/png"
}

function base64Bytes(data, param, limit) {
  if (typeof data !== "string" || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    invalid("Reference image data must be valid base64 or a base64 image data URL.", param, "invalid_reference_image")
  }
  const padding = data.endsWith("==") ? 2 : Number(data.endsWith("="))
  const length = data.length / 4 * 3 - padding
  if (length > limit) {
    invalid("Use at most 16 PNG, JPEG, or WebP reference images totaling 20 MiB or less.", "inputImages", "reference_images_too_large")
  }
  return Buffer.from(data, "base64")
}

function inlineData(value, param) {
  if (typeof value !== "string") invalid("Reference image data must be a string.", param, "invalid_reference_image")
  const trimmed = value.trim()
  if (/^data:/i.test(trimmed)) {
    const match = /^data:image\/[\w.+-]+;base64,([\s\S]+)$/i.exec(trimmed)
    if (!match) invalid("Reference images must use base64 image data URLs.", param, "invalid_reference_image")
    return match[1].replace(/\s+/g, "")
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    invalid("External reference URLs are not supported. Send an inline image data URL or a multipart image file; no credentials are sent to reference URLs.", param, "external_reference_url_unsupported")
  }
  return trimmed
}

function imageURL(value, param) {
  if (typeof value === "string") return value
  if (!object(value)) invalid("image_url must contain a URL string.", param, "invalid_reference_image")
  unsupportedFields(value, new Set(["url", "detail", "type"]), `${param}.`)
  if (value.type != null && value.type !== "image_url") invalid("Unsupported reference image type.", `${param}.type`, "invalid_reference_image")
  if (value.detail != null && value.detail !== "auto") {
    invalid("Aside reference images do not support a Chat image detail setting; use 'auto' or omit it.", `${param}.detail`, "unsupported_image_option")
  }
  return value.url
}

async function referenceImages(refs, signal) {
  if (refs.length > MAX_REFERENCE_IMAGES) {
    invalid("Use at most 16 PNG, JPEG, or WebP reference images totaling 20 MiB or less.", "inputImages", "too_many_reference_images")
  }
  const images = []
  let total = 0
  for (let index = 0; index < refs.length; index++) {
    signal?.throwIfAborted()
    const param = `inputImages[${index}]`
    let value = refs[index]
    let bytes
    if (value instanceof Blob) {
      if (value.size > MAX_REFERENCE_BYTES - total) {
        invalid("Reference images must total 20 MiB or less.", "inputImages", "reference_images_too_large")
      }
      bytes = Buffer.from(await value.arrayBuffer())
    } else {
      if (object(value)) {
        if ("image_url" in value) {
          unsupportedFields(value, new Set(["type", "image_url"]), `${param}.`)
          if (value.type != null && value.type !== "image_url") invalid("Unsupported reference image type.", `${param}.type`, "invalid_reference_image")
          value = imageURL(value.image_url, `${param}.image_url`)
        } else if ("url" in value) {
          value = imageURL(value, param)
        } else {
          unsupportedFields(value, new Set(["data", "mimeType"]), `${param}.`)
          if (value.mimeType != null && typeof value.mimeType !== "string") invalid("Reference image MIME type must be a string.", `${param}.mimeType`, "invalid_reference_image")
          value = value.data
        }
      }
      bytes = base64Bytes(inlineData(value, param), param, MAX_REFERENCE_BYTES - total)
    }
    signal?.throwIfAborted()
    const mimeType = sniffMime(bytes)
    if (!mimeType) invalid("Reference image must be a JPEG, PNG, or WebP file, identified from its bytes.", param, "unsupported_reference_image")
    total += bytes.length
    images.push({ data: bytes.toString("base64"), mimeType })
  }
  return images
}

function addReferences(refs, value, param, requireArray = false) {
  if (value === undefined || value === null) return
  if (requireArray && !Array.isArray(value)) invalid(`'${param}' must be an array of reference images.`, param)
  if (refs.length + (Array.isArray(value) ? value.length : 1) > MAX_REFERENCE_IMAGES) {
    invalid("Use at most 16 PNG, JPEG, or WebP reference images totaling 20 MiB or less.", "inputImages", "too_many_reference_images")
  }
  if (Array.isArray(value)) refs.push(...value)
  else refs.push(value)
}

function chatInput(body) {
  unsupportedFields(body, CHAT_FIELDS)
  if (body.stream === true) {
    invalid("Aside image models do not support Chat streaming. Use /images/generations or set stream:false.", "stream", "image_streaming_unsupported")
  }
  if (body.stream != null && body.stream !== false) invalid("'stream' must be false for Aside image models.", "stream")
  if (body.modalities != null && (!Array.isArray(body.modalities) || !body.modalities.includes("image") || body.modalities.some((mode) => mode !== "image" && mode !== "text"))) {
    invalid("Aside image models require image output; supported modalities are ['image'] or ['image','text'].", "modalities", "unsupported_image_option")
  }
  if (!Array.isArray(body.messages) || !body.messages.length) invalid("Image Chat requests require messages containing a text prompt.", "messages")
  const texts = []
  const refs = []
  for (let index = 0; index < body.messages.length; index++) {
    const message = body.messages[index]
    const param = `messages[${index}]`
    if (!object(message)) invalid("Each Chat message must be an object.", param)
    unsupportedFields(message, new Set(["role", "content", "images"]), `${param}.`)
    if (!["system", "developer", "user", "assistant"].includes(message.role)) invalid("Image Chat requests do not support tool or function messages.", `${param}.role`, "unsupported_image_option")
    if (typeof message.content === "string") texts.push(message.content)
    else if (Array.isArray(message.content)) {
      for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
        const part = message.content[partIndex]
        const partParam = `${param}.content[${partIndex}]`
        if (!object(part)) invalid("Chat image content parts must be text or image_url objects.", partParam)
        if (part.type === "text") {
          unsupportedFields(part, new Set(["type", "text"]), `${partParam}.`)
          if (typeof part.text !== "string") invalid("Chat prompt text must be a string.", `${partParam}.text`)
          texts.push(part.text)
        } else if (part.type === "image_url") {
          unsupportedFields(part, new Set(["type", "image_url"]), `${partParam}.`)
          refs.push(imageURL(part.image_url, `${partParam}.image_url`))
        } else {
          invalid("Aside image Chat supports text and image_url content only.", `${partParam}.type`, "unsupported_image_option")
        }
      }
    } else if (message.content != null) invalid("Chat message content must be text or a content-parts array.", `${param}.content`)
    addReferences(refs, message.images, `${param}.images`, true)
  }
  return { prompt: texts.join("\n"), refs }
}

function generationInput(body, edits) {
  unsupportedFields(body, IMAGE_FIELDS)
  for (const key of ["size", "quality", "background"]) {
    if (body[key] != null && body[key] !== "auto") {
      invalid(`Aside does not expose '${key}' controls. Use 'auto' or omit it; requested rendering options cannot be enforced.`, key, "unsupported_image_option")
    }
  }
  const format = body.response_format ?? "b64_json"
  if (format !== "b64_json" && format !== "url") invalid("'response_format' must be 'b64_json' or 'url' (an inline image data URL).", "response_format")
  const refs = []
  addReferences(refs, body.image, "image")
  addReferences(refs, body.images, "images")
  addReferences(refs, body.inputImages, "inputImages", true)
  if (edits && !refs.length) invalid("Image edits require at least one reference image in 'image' or 'inputImages'.", "image", "reference_image_required")
  return { prompt: body.prompt, refs, format }
}

function imageRequest(input, init, parsedBody) {
  if (parsedBody === undefined) return new Request(input, init)
  const original = input instanceof Request ? input : undefined
  const headers = init?.headers !== undefined ? new Headers(init.headers) : original?.headers ?? new Headers()
  if (/^multipart\/form-data(?:;|$)/i.test(headers.get("content-type") ?? "")) return new Request(input, init)
  return {
    url: original?.url ?? String(input),
    method: (init?.method ?? original?.method ?? "GET").toUpperCase(),
    headers,
    signal: init?.signal === undefined ? original?.signal : init.signal ?? undefined,
  }
}

async function requestBody(request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  try {
    if (contentType === "multipart/form-data") {
      const form = await request.formData()
      const body = Object.create(null)
      const images = []
      for (const [key, value] of form) {
        if (key === "image" || key === "image[]") images.push(value)
        else {
          if (Object.hasOwn(body, key)) invalid(`Multipart field '${key}' must not be repeated.`, key)
          if (key !== "mask" && typeof value !== "string") invalid(`Multipart field '${key}' must be text.`, key)
          body[key] = value
        }
      }
      if (images.length) body.image = images
      if (body.n !== undefined) {
        if (!/^\d+$/.test(body.n)) invalid("'n' must be an integer from 1 to 10.", "n")
        body.n = Number(body.n)
      }
      return body
    }
    if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
      throw new ImageRequestError(415, "Image requests require JSON or multipart/form-data.", "unsupported_media_type")
    }
    return await request.json()
  } catch (error) {
    request.signal.throwIfAborted()
    if (error instanceof ImageRequestError) throw error
    invalid("Image request body is not valid JSON or multipart/form-data.", null)
  }
}

function nativeResponse(value) {
  const bad = (message) => { throw new ImageRequestError(502, message, "invalid_image_response") }
  if (!object(value) || typeof value.model !== "string" || !value.model.length || !Array.isArray(value.images) || !value.images.length) {
    bad("Aside returned an invalid image response or no images.")
  }
  if (Object.keys(value).some((key) => key !== "model" && key !== "images")) bad("Aside returned unexpected image response fields.")
  const images = value.images.map((image) => {
    if (!object(image) || image.type !== "image" || !IMAGE_MIME_TYPES.has(image.mimeType) ||
        typeof image.data !== "string" || !image.data.length || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
        Object.keys(image).some((key) => key !== "type" && key !== "data" && key !== "mimeType")) {
      bad("Aside returned invalid image data.")
    }
    const mimeType = sniffMime(Buffer.from(image.data.slice(0, Math.ceil(SNIFF_BYTES / 3) * 4), "base64"))
    if (!mimeType) bad("Aside returned an unsupported image format, identified from its bytes.")
    return { data: image.data, mimeType }
  })
  return { model: value.model, images }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function errorResponse(error) {
  const status = error instanceof ImageRequestError || error instanceof AsideApiError ? error.status : error?.name === "TimeoutError" ? 504 : 502
  return jsonResponse({ error: {
    message: error instanceof Error ? error.message : "Aside image generation failed.",
    type: status >= 500 ? "api_error" : "invalid_request_error",
    code: error?.code ?? (status === 504 ? "image_generation_timeout" : "image_generation_failed"),
    param: error?.param ?? null,
  } }, status)
}

export async function handleImageRequest(input, init, { account, catalog, body: parsedBody }) {
  const request = imageRequest(input, init, parsedBody)
  try {
    request.signal?.throwIfAborted()
    const path = imagePath(request.url)
    const chat = path.endsWith("/chat/completions")
    const edits = path.endsWith("/images/edits")
    if (!chat && !edits && !path.endsWith("/images/generations")) {
      throw new ImageRequestError(404, "Unsupported Aside image endpoint.", "unsupported_image_endpoint")
    }
    if (request.method !== "POST") throw new ImageRequestError(405, "Image generation and editing require POST.", "method_not_allowed")
    const multipart = /^multipart\/form-data(?:;|$)/i.test(request.headers.get("content-type") ?? "")
    const body = parsedBody !== undefined && !multipart ? parsedBody : await requestBody(request)
    if (!object(body)) invalid("Image request body must be a JSON object.", null)
    const parsed = chat ? chatInput(body) : generationInput(body, edits)
    if (typeof body.model !== "string" || !body.model.trim()) invalid("An Aside image model ID is required.", "model")
    if (typeof parsed.prompt !== "string" || !parsed.prompt.trim() || parsed.prompt.trim().length > MAX_PROMPT_LENGTH) {
      invalid("Image prompt must contain 1 to 32,000 characters after trimming.", "prompt", "invalid_image_prompt")
    }
    const n = body.n ?? 1
    if (!Number.isInteger(n) || n < 1 || n > 10) invalid("'n' must be an integer from 1 to 10.", "n")
    const inputImages = await referenceImages(parsed.refs, request.signal)
    const current = typeof catalog?.get === "function" ? (await catalog.get({ signal: request.signal })).catalog : catalog
    request.signal?.throwIfAborted()
    if (!isImageModel(current, body.model)) invalid(`'${body.model}' is not an Aside image model.`, "model", "invalid_image_model")
    const nativeBody = { model: body.model, prompt: parsed.prompt.trim(), ...(inputImages.length ? { inputImages } : {}) }
    const results = []
    // Aside has no 'n' option: each requested result uses one native generation, without transient retries.
    for (let index = 0; index < n; index++) {
      request.signal?.throwIfAborted()
      const result = nativeResponse(await account.json("/ai/images/generations", {
        method: "POST", body: nativeBody, signal: request.signal, timeoutMs: 150000, timeoutScope: "body", retry: 0,
      }))
      request.signal?.throwIfAborted()
      if (results.length && results[0].model !== result.model) {
        throw new ImageRequestError(502, "Aside returned inconsistent image model IDs across the requested generations.", "invalid_image_response")
      }
      results.push(result)
    }
    const created = Math.floor(Date.now() / 1000)
    if (chat) {
      return jsonResponse({
        id: `chatcmpl-aside-${randomUUID()}`, object: "chat.completion", created, model: results[0].model,
        choices: results.map((result, index) => ({
          index,
          message: { role: "assistant", content: "", images: result.images.map((image) => ({
            type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })) },
          finish_reason: "stop",
        })),
      })
    }
    const data = results.flatMap((result) => result.images.map((image) => ({
      ...(parsed.format === "url" ? { url: `data:${image.mimeType};base64,${image.data}` } : { b64_json: image.data }),
      media_type: image.mimeType,
    })))
    return jsonResponse({ created, data })
  } catch (error) {
    request.signal?.throwIfAborted()
    if (error?.name === "AbortError") throw error
    return errorResponse(error)
  }
}
