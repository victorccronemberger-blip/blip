import { Cause, Context, Effect, Layer, Option, Schedule, Semaphore } from "effect"
import { generateObject, streamObject, type ModelMessage } from "ai"
import z from "zod"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { InstanceState } from "@/effect"
import { EffectLogger } from "@/effect"
import { Provider, ProviderTransform } from "@/provider"
import type { ProviderID, ModelID } from "@/provider/schema"
import { Auth } from "@/auth"
import { Config } from "@/config"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { SessionRetry } from "./retry"

/**
 * Per-session stop-condition goal. `/goal`: once a goal
 * is set, the main runLoop refuses to stop until an independent judge model
 * decides the condition is satisfied (or genuinely impossible). The judge is a
 * separate model call that only reads the transcript — it does not do the work,
 * so its verdict stays cold relative to the working agent's optimism.
 *
 * State lives in InstanceState (per project instance), keyed by sessionID, and
 * is cleared on instance teardown. See run-state.ts for the sibling pattern.
 */

export type Goal = {
  condition: string
  /** Number of judge-driven re-entries so far; bounded by MAX_GOAL_REACT in prompt.ts. */
  react: number
  /** Monotonic identity used to reject verdicts produced for an older goal. */
  revision: number
}

export const Verdict = z.object({
  ok: z.boolean(),
  impossible: z.boolean().optional(),
  reason: z.string(),
})
export type Verdict = z.infer<typeof Verdict>

export type PublishedVerdict = Verdict & {
  attempt: number
  messageID?: string
  error?: boolean
  paused?: "judge_error" | "safety_limit"
}

/**
 * Broadcast whenever a session's goal changes — set, judged, or cleared. The
 * TUI mirrors this into its sync store to render the active-goal indicator and
 * the latest judge verdict. `goal` undefined means there is no active goal
 * (cleared / satisfied / impossible). Mirrors session/status.ts's Event.Status.
 */
export const Event = {
  Updated: BusEvent.define(
    "session.goal",
    z.object({
      sessionID: SessionID.zod,
      goal: z.object({ condition: z.string() }).optional(),
      lastVerdict: Verdict.extend({
        attempt: z.number(),
        /** The assistant message the judge evaluated — anchors the verdict to a turn. */
        messageID: z.string().optional(),
        error: z.boolean().optional(),
        paused: z.enum(["judge_error", "safety_limit"]).optional(),
      }).optional(),
    }),
  ),
}

// ---- Judge prompts  ----

const JUDGE_SYSTEM = `You are evaluating a stop-condition hook in Mimo Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

// The closing question appended after the full conversation.
const judgeUser = (condition: string) =>
  `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`

export interface Interface {
  readonly set: (sessionID: SessionID, condition: string) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Goal | undefined>
  /** Clear unconditionally, or only when the active goal matches `revision`. */
  readonly clear: (sessionID: SessionID, revision?: number) => Effect.Effect<boolean>
  /** Atomically clear a matching goal and publish its final verdict. */
  readonly finish: (sessionID: SessionID, revision: number, verdict: PublishedVerdict) => Effect.Effect<boolean>
  /** Increment the re-entry counter, returning the new count. */
  readonly bumpReact: (sessionID: SessionID, revision?: number) => Effect.Effect<number | undefined>
  /**
   * Run the judge over the conversation against the active goal's condition.
   * `msgs` is the main thread's message list; it is converted to native model
   * messages (tool calls/results/images preserved) so the judge independently
   * confirms the work rather than trusting the assistant's self-report.
   */
  readonly evaluate: (input: {
    condition: string
    msgs: MessageV2.WithParts[]
    model: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<Verdict, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const elog = EffectLogger.create({ service: "SessionGoal" })
    const lock = Semaphore.makeUnsafe(1)

    const state = yield* InstanceState.make(
      Effect.fn("SessionGoal.state")(function* () {
        return { goals: new Map<string, Goal>(), revision: 0 }
      }),
    )

    const set = Effect.fn("SessionGoal.set")(function* (sessionID: SessionID, condition: string) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const data = yield* InstanceState.get(state)
          data.revision += 1
          data.goals.set(sessionID, { condition, react: 0, revision: data.revision })
          yield* elog.info("goal set", { sessionID, conditionLength: condition.length })
          yield* bus.publish(Event.Updated, { sessionID, goal: { condition } })
        }),
      )
    })

    const get = Effect.fn("SessionGoal.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.goals.get(sessionID)
    })

    const clear = Effect.fn("SessionGoal.clear")(function* (sessionID: SessionID, revision?: number) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const data = yield* InstanceState.get(state)
          const current = data.goals.get(sessionID)
          if (!current || (revision !== undefined && current.revision !== revision)) return false
          data.goals.delete(sessionID)
          yield* elog.info("goal cleared", { sessionID })
          yield* bus.publish(Event.Updated, { sessionID, goal: undefined })
          return true
        }),
      )
    })

    const finish = Effect.fn("SessionGoal.finish")(function* (
      sessionID: SessionID,
      revision: number,
      verdict: PublishedVerdict,
    ) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const data = yield* InstanceState.get(state)
          if (data.goals.get(sessionID)?.revision !== revision) return false
          data.goals.delete(sessionID)
          yield* elog.info("goal finished", { sessionID, impossible: verdict.impossible === true })
          yield* bus.publish(Event.Updated, { sessionID, goal: undefined, lastVerdict: verdict })
          return true
        }),
      )
    })

    const bumpReact = Effect.fn("SessionGoal.bumpReact")(function* (sessionID: SessionID, revision?: number) {
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const data = yield* InstanceState.get(state)
          const goal = data.goals.get(sessionID)
          if (!goal) return revision === undefined ? 0 : undefined
          if (revision !== undefined && goal.revision !== revision) return undefined
          goal.react += 1
          return goal.react
        }),
      )
    })

    const evaluate = Effect.fn("SessionGoal.evaluate")(function* (input: {
      condition: string
      msgs: MessageV2.WithParts[]
      model: { providerID: ProviderID; modelID: ModelID }
    }) {
      const cfg = yield* config.get()
      const resolved = yield* provider.getModel(input.model.providerID, input.model.modelID)
      const language = yield* provider.getLanguage(resolved)
      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined

      const authInfo = yield* auth.get(input.model.providerID).pipe(Effect.orDie)
      const isOpenaiOauth = input.model.providerID === "openai" && authInfo?.type === "oauth"

      // Convert the conversation to native model messages so the judge sees the
      // real tool calls/results/images — same context the working agent had.
      const conversation = yield* MessageV2.toModelMessagesEffect(input.msgs, resolved)

      // Never write the transcript or goal text to logs: both may contain
      // credentials, personal data, or private source code.
      yield* elog.debug("goal judge transcript", {
        conditionLength: input.condition.length,
        messageCount: conversation.length + (isOpenaiOauth ? 1 : 2),
      })

      const params = {
        experimental_telemetry: {
          isEnabled: cfg.experimental?.openTelemetry,
          tracer,
          metadata: { userId: cfg.username ?? "unknown" },
        },
        temperature: 0,
        messages: [
          ...(isOpenaiOauth ? [] : [{ role: "system", content: JUDGE_SYSTEM } satisfies ModelMessage]),
          ...conversation,
          {
            role: "user",
            content: judgeUser(input.condition),
          } satisfies ModelMessage,
        ],
        model: language,
        schema: Verdict,
      } satisfies Parameters<typeof generateObject>[0]

      const judge = isOpenaiOauth
        ? Effect.tryPromise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: JUDGE_SYSTEM,
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return Verdict.parse(await result.object)
          })
        : Effect.tryPromise(() => generateObject(params).then((r) => Verdict.parse(r.object)))

      return yield* judge.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.fail(Cause.squash(cause)),
        ),
        Effect.retry({
          while: SessionRetry.isRetryableTransientError,
          schedule: Schedule.exponential("500 millis", 2).pipe(Schedule.both(Schedule.recurs(2))),
        }),
      )
    })

    return Service.of({ set, get, clear, finish, bumpReact, evaluate })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
)

export * as Goal from "./goal"
