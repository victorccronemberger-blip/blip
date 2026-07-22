import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Truncate } from "../../src/tool"
import { ConsultTool } from "../../src/tool/consult"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

afterEach(async () => {
  await Instance.disposeAll()
})

// Three models under one provider: model-a and model-b will be allowlisted in
// `consult.models` by individual tests; model-c is deliberately left OFF the
// allowlist (even though the fake provider can resolve it) to exercise the
// tool's enforcement path.
const modelA = ProviderTest.model({ id: ModelID.make("model-a"), providerID: ProviderID.make("acme"), name: "Model A" })
const modelB = ProviderTest.model({ id: ModelID.make("model-b"), providerID: ProviderID.make("acme"), name: "Model B" })
const modelC = ProviderTest.model({ id: ModelID.make("model-c"), providerID: ProviderID.make("acme"), name: "Model C" })

const refA = `${modelA.providerID}/${modelA.id}`
const refB = `${modelB.providerID}/${modelB.id}`
const refC = `${modelC.providerID}/${modelC.id}`

const modelMap: Record<string, typeof modelA> = {
  [refA]: modelA,
  [refB]: modelB,
  [refC]: modelC,
}

const providerInfo = ProviderTest.info(
  { id: ProviderID.make("acme"), models: { [modelA.id]: modelA, [modelB.id]: modelB, [modelC.id]: modelC } },
  modelA,
)

// Tracks whether the tool ever reached provider.getLanguage — the step right
// before generateText. Enforcement must stop disallowed models BEFORE this is
// called; it always dies here (deliberately) so a passing enforcement test
// can't be confused with a passing *generation* test — we're not mocking the
// full generateText/ai-sdk path (impractical with this harness), just proving
// the allowlist gate fires (or doesn't) at the right point.
let getLanguageCalls = 0

const providerFake = ProviderTest.fake({
  model: modelA,
  info: providerInfo,
  resolveModelRef: Effect.fn("ConsultTest.resolveModelRef")((ref: string) => {
    const mdl = modelMap[ref]
    if (!mdl) return Effect.die(new Error(`Unknown test model: ${ref}`))
    return Effect.succeed(mdl)
  }),
  getLanguage: Effect.fn("ConsultTest.getLanguage")(() => {
    getLanguageCalls++
    return Effect.die(new Error("consult.test: reached getLanguage — should only happen post-enforcement"))
  }),
})

const it = testEffect(
  Layer.mergeAll(
    Config.defaultLayer,
    providerFake.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function ctx(sessionID: string) {
  return {
    sessionID: SessionID.make(sessionID),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

const initTool = Effect.fn("ConsultTest.initTool")(function* () {
  const info = yield* ConsultTool
  return yield* info.init()
})

describe("consult tool", () => {
  it.live(
    "list_models returns the configured allowlist",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* initTool()
          const result = yield* tool.execute({ operation: { action: "list_models" } }, ctx("s1"))

          expect(result.metadata.count).toBe(2)
          expect(result.metadata.models).toEqual([refA, refB])
          expect(result.output).toContain(refA)
          expect(result.output).toContain(refB)
          expect(result.output).not.toContain(refC)
        }),
      { config: { consult: { models: [refA, refB] } } },
    ),
  )

  it.live(
    "list_models with no consult.models lists ALL configured models (permission mode)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* initTool()
        const result = yield* tool.execute({ operation: { action: "list_models" } }, ctx("s2"))

        // No explicit allowlist → every configured model is a candidate; the TUI
        // permission prompt gates each use. The fake provider exposes 3 models.
        expect(result.metadata.mode).toBe("permission")
        expect(result.metadata.count).toBe(3)
        expect(result.metadata.models).toEqual([refA, refB, refC].sort())
        expect(result.output).toContain("approve each one in the TUI")
      }),
    ),
  )

  it.live(
    "ask with a model NOT on the allowlist fails and never reaches generation",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* initTool()
          const before = getLanguageCalls

          const exit = yield* Effect.exit(
            tool.execute({ operation: { action: "ask", model: refC, prompt: "hi" } }, ctx("s3")),
          )

          expect(exit._tag).toBe("Failure")
          // Enforcement must short-circuit BEFORE provider.getLanguage — confirms
          // this failed on the allowlist check, not some incidental error later.
          expect(getLanguageCalls).toBe(before)
        }),
      { config: { consult: { models: [refA, refB] } } },
    ),
  )

  it.live(
    "ask with no consult.models is permission-gated: a configured model clears the gate",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* initTool()
        const before = getLanguageCalls

        // Permission mode (no explicit allowlist): ANY configured model may be
        // consulted, gated by ctx.ask (the TUI prompt). The test ctx auto-allows,
        // so an allowed/configured model reaches getLanguage.
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "ask", model: refA, prompt: "hi" } }, ctx("s4")),
        )

        expect(exit._tag).toBe("Failure") // fake dies at getLanguage by design
        expect(getLanguageCalls).toBe(before + 1)
      }),
    ),
  )

  it.live(
    "ask with no consult.models rejects a NON-configured model before generation",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* initTool()
        const before = getLanguageCalls

        // Permission mode still can't consult a model that isn't configured at all.
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "ask", model: "ghost/model-x", prompt: "hi" } }, ctx("s4b")),
        )

        expect(exit._tag).toBe("Failure")
        expect(getLanguageCalls).toBe(before)
      }),
    ),
  )

  it.live(
    "ask with an ALLOWED model passes enforcement (reaches getLanguage)",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* initTool()
          const before = getLanguageCalls

          const exit = yield* Effect.exit(
            tool.execute({ operation: { action: "ask", model: refA, prompt: "hi" } }, ctx("s5")),
          )

          // This model IS allowlisted, so it must clear the enforcement gate and
          // reach getLanguage — where the fake deliberately dies (we aren't
          // mocking full generateText). A Failure here is expected; the point is
          // WHERE it failed.
          expect(exit._tag).toBe("Failure")
          expect(getLanguageCalls).toBe(before + 1)
        }),
      { config: { consult: { models: [refA, refB] } } },
    ),
  )

  it.live(
    "ask with no model falls back to consult.default_model and passes enforcement",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* initTool()
          const before = getLanguageCalls

          const exit = yield* Effect.exit(
            tool.execute({ operation: { action: "ask", prompt: "hi" } }, ctx("s6")),
          )

          // default_model (refA) is allowlisted → clears enforcement and reaches
          // getLanguage (fake dies there). Proves the fallback wires a real target.
          expect(exit._tag).toBe("Failure")
          expect(getLanguageCalls).toBe(before + 1)
        }),
      { config: { consult: { models: [refA, refB], default_model: refA } } },
    ),
  )

  it.live(
    "ask with no model and no default_model fails closed before generation",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* initTool()
          const before = getLanguageCalls

          const exit = yield* Effect.exit(
            tool.execute({ operation: { action: "ask", prompt: "hi" } }, ctx("s7")),
          )

          expect(exit._tag).toBe("Failure")
          expect(getLanguageCalls).toBe(before)
        }),
      { config: { consult: { models: [refA, refB] } } },
    ),
  )

  it.live(
    "operation schema parses both list_models and ask, and rejects a malformed ask",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const tool = yield* initTool()

          expect(() => tool.parameters.parse({ operation: { action: "list_models" } })).not.toThrow()
          expect(() =>
            tool.parameters.parse({ operation: { action: "ask", model: refA, prompt: "hi" } }),
          ).not.toThrow()
          // missing required `prompt`
          expect(() => tool.parameters.parse({ operation: { action: "ask", model: refA } })).toThrow()
          // `model` is optional (falls back to consult.default_model), so an ask
          // without it still parses — enforcement of "must have a target" happens
          // at execute time, not in the schema.
          expect(() => tool.parameters.parse({ operation: { action: "ask", prompt: "hi" } })).not.toThrow()
          // unknown action
          expect(() => tool.parameters.parse({ operation: { action: "bogus" } })).toThrow()
        }),
      { config: { consult: { models: [refA, refB] } } },
    ),
  )
})
