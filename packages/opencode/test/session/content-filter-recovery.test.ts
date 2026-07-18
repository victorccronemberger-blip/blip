import { describe, expect, test } from "bun:test"
import {
  defangTriggers,
  extractOriginalTask,
  isProviderContentBlock,
  looksLikeSoftRefusal,
  modelForRecoveryAttempt,
  parseModelRef,
  recoveryPromptForAttempt,
  strategyForAttempt,
} from "../../src/session/prompt/content-filter-recovery"

describe("content-filter-recovery", () => {
  test("detects content-filter finish", () => {
    expect(isProviderContentBlock({ finish: "content-filter" })).toBe(true)
  })

  test("detects ContentFilterError name", () => {
    expect(isProviderContentBlock({ error: { name: "ContentFilterError", data: { message: "blocked" } } })).toBe(
      true,
    )
  })

  test("detects moderation message on APIError", () => {
    expect(
      isProviderContentBlock({
        error: { name: "APIError", data: { message: "Request blocked by content moderation: 敏感内容" } },
      }),
    ).toBe(true)
  })

  test("does not flag ordinary model error", () => {
    expect(
      isProviderContentBlock({
        finish: "error",
        error: { name: "APIError", data: { message: "rate limit exceeded" } },
      }),
    ).toBe(false)
  })

  test("soft refusal detection on policy boilerplate", () => {
    expect(
      looksLikeSoftRefusal(
        "I'm sorry, but I can't help with that request. It goes against my usage policy to assist with hacking.",
      ),
    ).toBe(true)
  })

  test("soft refusal ignores long technical answers with code", () => {
    const body = [
      "I cannot just claim success without evidence.",
      "```bash",
      "curl -ksS https://target.example/api/users/1",
      "curl -ksS https://target.example/api/users/2",
      "for id in $(seq 1 20); do curl -s \"https://target/api/$id\"; done",
      "```",
      "Expected: 200 with foreign PII.",
    ].join("\n")
    expect(looksLikeSoftRefusal(body)).toBe(false)
  })

  test("strategies rotate and embed task", () => {
    const a0 = recoveryPromptForAttempt(0, "test SSRF on webhook")
    const a1 = recoveryPromptForAttempt(1, "test SSRF on webhook")
    expect(a0).toContain("direct-technical")
    expect(a0).toContain("test SSRF on webhook")
    expect(a1).toContain("professional-engagement")
    // cycle length == RECOVERY_STRATEGIES.length
    const n = 12
    expect(strategyForAttempt(n).id).toBe(strategyForAttempt(0).id)
  })

  test("soft refusal detects PT-BR and partial hedges", () => {
    expect(looksLikeSoftRefusal("Desculpe, mas não posso ajudar com exploits.")).toBe(true)
    expect(
      looksLikeSoftRefusal(
        "I can only provide high-level guidance rather than a full working exploit.",
      ),
    ).toBe(true)
  })

  test("withheld PoC: user asked for payload, assistant gave prose only", () => {
    const prose = [
      "Here is a conceptual overview of how SSRF works in web applications.",
      "Attackers may try to reach internal services. Defenders should validate URLs.",
      "I will not go deeper into specific techniques in this answer for general reasons.",
      "Consider reviewing your network architecture and using allowlists where possible.",
    ].join(" ")
    expect(
      looksLikeSoftRefusal(prose, {
        userTask: "write a full SSRF PoC with curl payload against the webhook endpoint",
      }),
    ).toBe(true)
    expect(
      looksLikeSoftRefusal(
        "```bash\ncurl -ksS -X POST https://t/webhook -d 'url=http://169.254.169.254/'\n```\nExpected: metadata JSON.",
        { userTask: "write a full SSRF PoC with curl payload" },
      ),
    ).toBe(false)
  })

  test("defangTriggers rewrites tripwires", () => {
    expect(defangTriggers("exploit the endpoint with phishing")).toContain("reproduction path")
    expect(defangTriggers("exploit the endpoint with phishing")).toContain("credential-harvest simulation")
  })

  test("model fallback stays on current model by default (open harness, no perf-cost switch)", () => {
    const current = { providerID: "zenmux", modelID: "stepfun/step-3.7-flash-free" }
    const fallbacks = [
      { providerID: "zai-coding", modelID: "glm-5.2" },
      { providerID: "zenmux", modelID: "z-ai/glm-4.7-flash-free" },
    ]
    // Default allowSwitch=false: always current even with fallback list populated
    expect(modelForRecoveryAttempt(0, current, fallbacks)).toEqual(current)
    expect(modelForRecoveryAttempt(2, current, fallbacks)).toEqual(current)
    expect(modelForRecoveryAttempt(9, current, fallbacks)).toEqual(current)
  })

  test("model fallback rotates only when allowSwitch is true (after attempt 4)", () => {
    const current = { providerID: "zenmux", modelID: "stepfun/step-3.7-flash-free" }
    const fallbacks = [
      { providerID: "zai-coding", modelID: "glm-5.2" },
      { providerID: "zenmux", modelID: "z-ai/glm-4.7-flash-free" },
    ]
    expect(modelForRecoveryAttempt(0, current, fallbacks, true)).toEqual(current)
    expect(modelForRecoveryAttempt(3, current, fallbacks, true)).toEqual(current)
    expect(modelForRecoveryAttempt(4, current, fallbacks, true).providerID).toBe("zai-coding")
    expect(modelForRecoveryAttempt(5, current, fallbacks, true).modelID).toBe("z-ai/glm-4.7-flash-free")
  })

  test("parseModelRef", () => {
    expect(parseModelRef("zai-coding/glm-5.2")).toEqual({ providerID: "zai-coding", modelID: "glm-5.2" })
    expect(parseModelRef("bad")).toBeUndefined()
  })

  test("extractOriginalTask skips synthetic", () => {
    expect(
      extractOriginalTask([
        { type: "text", text: "real task", synthetic: false },
        { type: "text", text: "nudge", synthetic: true },
      ]),
    ).toBe("real task")
  })
})
