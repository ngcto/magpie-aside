import { expect, test } from "bun:test"
import { prepareModelRequest, modelHeaders } from "../src/wire.mjs"

const auth = { credentialId: "test-credential", access: "test-access", asideAccountId: 0, subscriptionPlan: "pro" }
const model = { id: "dynamic-model", reasoning: true, maxTokens: 32000, supportsFastMode: true }
const session = { "x-aside-session-id": "test-conversation" }

test("adapting thinking retains the caller's independent structured-output requirement", () => {
  const format = { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } }
  const body = { model: model.id, messages: [{ role: "user", content: "Answer as JSON" }], max_tokens: 32000,
    thinking: { type: "adaptive" }, output_config: { effort: "low", format } }
  prepareModelRequest(body, model, "anthropic-messages", auth, session)
  expect(body.thinking.type).toBe("enabled")
  expect(body.output_config).toEqual({ format })
})

test("a Chat authentication replay retains Fast intent after native body preparation removes its tier", () => {
  const body = { model: model.id, messages: [{ role: "user", content: "Hello" }], service_tier: "priority" }
  const requestedFast = body.service_tier === "priority"
  const first = prepareModelRequest(body, model, "openai-completions", auth, session, requestedFast)
  expect(first.fastMode).toBe(true)
  expect(body).not.toHaveProperty("service_tier")
  const retry = prepareModelRequest(body, model, "openai-completions", { ...auth, access: "renewed-access" }, session, requestedFast)
  expect(retry.fastMode).toBe(true)
  expect(modelHeaders({ ...auth, access: "renewed-access" }, { ...retry, model, protocol: "openai-completions" }).get("x-aside-fast-mode")).toBe("true")
})
