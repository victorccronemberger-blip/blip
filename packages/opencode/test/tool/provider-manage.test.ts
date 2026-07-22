import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Truncate } from "../../src/tool"
import { ProviderManageTool } from "../../src/tool/provider-manage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderTest } from "../fake/provider"

afterEach(async () => {
  await Instance.disposeAll()
  delete process.env.MIMOCODE_AUTH_CONTENT
})

const modelA = ProviderTest.model({ id: ModelID.make("model-a"), providerID: ProviderID.make("acme"), name: "Model A" })
const providerInfo = ProviderTest.info({ id: ProviderID.make("acme"), models: { [modelA.id]: modelA } }, modelA)
const providerFake = ProviderTest.fake({ model: modelA, info: providerInfo })

const it = testEffect(
  Layer.mergeAll(
    Config.defaultLayer,
    providerFake.layer,
    Auth.defaultLayer,
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

const initTool = Effect.fn("ProviderManageTest.initTool")(function* () {
  const info = yield* ProviderManageTool
  return yield* info.init()
})

describe("providers tool", () => {
  it.live(
    "list_connected lists the ACTIVE providers (from provider.list, not just auth)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* initTool()
        const result = yield* tool.execute({ operation: { action: "list_connected" } }, ctx("p1"))

        // The fake exposes one active provider ("acme", source "config") — this is
        // the fix: a config/env provider shows up here even with no auth.json entry.
        expect(result.metadata.active).toEqual(["acme"])
        expect(result.metadata.removed).toEqual([])
        expect(result.output).toContain("acme")
        expect(result.output).toContain("config")
      }),
    ),
  )

  it.live(
    "remove rejects a provider that isn't active (before any write)",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* initTool()

        // "ghost" is not an active provider → known.length === 0 → fails before
        // ctx.ask and before any auth.remove / config.update write.
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "remove", providers: ["ghost"] } }, ctx("p3")),
        )

        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "enable rejects a provider that isn't currently removed",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* initTool()

        // Nothing is in disabled_providers → enabling anything fails.
        const exit = yield* Effect.exit(
          tool.execute({ operation: { action: "enable", providers: ["acme"] } }, ctx("p4")),
        )

        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "operation schema parses all three actions and rejects malformed input",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* initTool()

        expect(() => tool.parameters.parse({ operation: { action: "list_connected" } })).not.toThrow()
        expect(() =>
          tool.parameters.parse({ operation: { action: "remove", providers: ["openai"] } }),
        ).not.toThrow()
        expect(() =>
          tool.parameters.parse({ operation: { action: "enable", providers: ["openai"] } }),
        ).not.toThrow()
        // remove/enable require a non-empty providers array
        expect(() => tool.parameters.parse({ operation: { action: "remove", providers: [] } })).toThrow()
        expect(() => tool.parameters.parse({ operation: { action: "enable", providers: [] } })).toThrow()
        expect(() => tool.parameters.parse({ operation: { action: "remove" } })).toThrow()
        expect(() => tool.parameters.parse({ operation: { action: "bogus" } })).toThrow()
      }),
    ),
  )
})
