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

test("Aside Messages omits rejected server-side context editing without editing conversation history", () => {
  const messages = [
    { role: "assistant", content: [
      { type: "thinking", thinking: "Use the lookup tool", signature: "thinking-signature" },
      { type: "tool_use", id: "call-1", name: "lookup", input: { query: "test" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "lookup result" }] },
  ]
  const original = structuredClone(messages)
  const contextManagement = { edits: [{ type: "clear_thinking_20251015", keep: "all" },
    { type: "clear_tool_uses_20250919", trigger: { type: "input_tokens", value: 10000 }, keep: { type: "tool_uses", value: 3 } }] }
  for (const thinking of [undefined, { type: "disabled" }, { type: "enabled", budget_tokens: 2048 }, { type: "adaptive" }]) {
    const body = { model: model.id, messages: structuredClone(messages), max_tokens: 32000,
      thinking, context_management: contextManagement }
    prepareModelRequest(body, model, "anthropic-messages", auth, session)
    expect(body).not.toHaveProperty("context_management")
    expect(body.messages).toEqual(original)
  }
})

test("Responses retains its independent context-management configuration", () => {
  const contextManagement = [{ type: "compaction", compact_threshold: 10000 }]
  const body = { model: model.id, input: "Hello", context_management: contextManagement }
  prepareModelRequest(body, model, "openai-responses", auth, session)
  expect(body.context_management).toEqual(contextManagement)
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

for (const protocol of ["openai-responses", "openai-completions"]) {
  test(`${protocol} removes GPT reasoning sampling without losing independent output constraints`, () => {
    const format = { type: "json_schema", name: "answer", schema: { type: "object" } }
    const gpt = { ...model, id: "gpt-future", availableThinkingLevels: ["off", "low", "high"] }
    for (const effort of [undefined, "low", "high"]) {
      const body = { model: gpt.id, temperature: 0.4, top_p: 0.9, top_logprobs: 2,
        ...(protocol === "openai-responses"
          ? { input: "Hello", reasoning: effort === undefined ? undefined : { effort }, text: { format },
            include: ["message.output_text.logprobs", "reasoning.encrypted_content", "web_search_call.action.sources"] }
          : { messages: [{ role: "user", content: "Hello" }], reasoning_effort: effort, logprobs: true, response_format: format }) }
      prepareModelRequest(body, gpt, protocol, auth, session)
      expect(body).not.toHaveProperty("temperature")
      expect(body).not.toHaveProperty("top_p")
      expect(body).not.toHaveProperty("top_logprobs")
      if (protocol === "openai-responses") {
        expect(body.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"])
        expect(body.text.format).toBe(format)
      } else {
        expect(body).not.toHaveProperty("logprobs")
        expect(body.response_format).toBe(format)
      }
    }
  })

  test(`${protocol} retains sampling only for a catalog-supported GPT non-reasoning turn`, () => {
    for (const effort of ["off", "none"]) {
      const gpt = { ...model, id: "gpt-future", availableThinkingLevels: ["off", "low"] }
      const body = { model: gpt.id, temperature: 0, top_p: 0.7, top_logprobs: 2,
        ...(protocol === "openai-responses"
          ? { input: "Hello", reasoning: { effort }, include: ["message.output_text.logprobs"] }
          : { messages: [{ role: "user", content: "Hello" }], reasoning_effort: effort, logprobs: true }) }
      prepareModelRequest(body, gpt, protocol, auth, session)
      expect(body.temperature).toBe(0)
      expect(body.top_p).toBe(0.7)
      expect(body.top_logprobs).toBe(2)
      if (protocol === "openai-responses") {
        expect(body.reasoning.effort).toBe("none")
        expect(body.include).toEqual(["message.output_text.logprobs"])
      } else {
        expect(body.reasoning_effort).toBe("none")
        expect(body.logprobs).toBe(true)
      }
      prepareModelRequest(body, { ...gpt, availableThinkingLevels: ["low", "high"] }, protocol, auth, session)
      expect(body).not.toHaveProperty("temperature")
      expect(body).not.toHaveProperty("top_p")
    }
  })

  test(`${protocol} preserves sampling for other reasoning families and non-reasoning GPT models`, () => {
    for (const entry of [{ ...model, id: "grok-future" }, { ...model, id: "gemini-future" }, { ...model, id: "gpt-future-chat", reasoning: false }]) {
      const body = { model: entry.id, temperature: 0.4, top_p: 0.9,
        ...(protocol === "openai-responses" ? { input: "Hello", reasoning: { effort: "low" } }
          : { messages: [{ role: "user", content: "Hello" }], reasoning_effort: "low" }) }
      prepareModelRequest(body, entry, protocol, auth, session)
      expect(body.temperature).toBe(0.4)
      expect(body.top_p).toBe(0.9)
    }
  })
}
