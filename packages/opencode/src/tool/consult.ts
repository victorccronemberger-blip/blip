import z from "zod"
import { Cause, Effect } from "effect"
import { generateText, wrapLanguageModel } from "ai"
import * as Tool from "./tool"
import { RecoverableError } from "./recoverable"
import DESCRIPTION from "./consult.txt"
import { Config } from "../config"
import { Provider, ProviderTransform } from "@/provider"
import { InstallationVersion } from "@/installation/version"
import { errorMessage } from "@/util/error"

const id = "consult"

const listModelsSchema = z.strictObject({
  action: z
    .literal("list_models")
    .describe("List the models the `consult` tool is allowed to call (the user-configured allowlist)."),
})

const askSchema = z.strictObject({
  action: z.literal("ask").describe("Ask ONE allowlisted model a one-shot question and get back its answer."),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A model from the consult allowlist — either a provider/model string or a model_groups name. Call `list_models` first if unsure what's configured. If omitted, falls back to consult.default_model from config.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe("The question or task to send to the other model. Be self-contained — it has no access to this conversation."),
  system: z.string().optional().describe("(optional) System prompt to steer the other model's answer."),
  temperature: z.number().optional().describe("(optional) Sampling temperature, if the model supports it."),
})

// Resolve every allowlist entry (provider/model or model_groups name) to a
// concrete "providerID/id" string, dropping entries that fail to resolve
// (stale config, disabled provider, etc.) rather than hard-failing the whole
// call. Order-preserving, deduped.
const resolveAllowlist = Effect.fn("ConsultTool.resolveAllowlist")(function* (
  provider: Provider.Interface,
  allowlist: readonly string[],
) {
  const seen = new Set<string>()
  const resolved: string[] = []
  for (const ref of allowlist) {
    const exit = yield* provider.resolveModelRef(ref).pipe(Effect.exit)
    if (exit._tag !== "Success") continue
    const key = `${exit.value.providerID}/${exit.value.id}`
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push(key)
  }
  return resolved
})

// Every model configured in this install as "providerID/id", sorted & deduped.
// Used as the candidate set in "permission mode" (no explicit consult.models):
// any configured model may be consulted, but each use is gated by the TUI
// permission prompt — so the user still chooses, with zero JSON editing.
const allConfiguredModels = Effect.fn("ConsultTool.allConfiguredModels")(function* (provider: Provider.Interface) {
  const providers = yield* provider.list()
  const keys = Object.values(providers).flatMap((info) =>
    Object.values(info.models).map((m) => `${m.providerID}/${m.id}`),
  )
  return [...new Set(keys)].sort()
})

export const ConsultTool = Tool.define(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service

    const parameters = z.strictObject({
      // .meta({ type: "object" }) is REQUIRED — same rationale as actor.ts:
      // without it the emitted JSON schema's `operation` node has only `anyOf`,
      // no `type`, and some models stringify the whole envelope instead of
      // nesting it, which then fails zod validation.
      operation: z.discriminatedUnion("action", [listModelsSchema, askSchema]).meta({ type: "object" }),
    })

    const run = Effect.fn("ConsultTool.execute")(function* (input: z.infer<typeof parameters>, ctx: Tool.Context) {
      const op = input.operation
      const cfg = yield* config.get()
      const allowlist = cfg.consult?.models ?? []
      // Two gating modes, no JSON editing required for the easy path:
      //  - explicit:   consult.models is set → only those (pre-approved) models.
      //  - permission: consult.models is empty → ANY configured model may be
      //                consulted, but each use goes through the TUI permission
      //                prompt (once / always / deny). "always" persists, so the
      //                user builds their allowlist right from the chat.
      const explicit = allowlist.length > 0

      if (op.action === "list_models") {
        if (!explicit) {
          const all = yield* allConfiguredModels(provider)
          if (all.length === 0) {
            return {
              title: "Consult: no models available",
              output: "No models are configured in this install. Connect a provider first, then any model can be consulted.",
              metadata: { count: 0, mode: "permission" } as Record<string, any>,
            }
          }
          const lines = all.map((r) => `- ${r}`).join("\n")
          return {
            title: "Consult: available models",
            output:
              `No fixed consult allowlist is set, so any configured model can be consulted — you approve each one in the TUI ` +
              `the first time it's used (pick "always" to remember it). No config editing needed.\n\n` +
              `Configured models (${all.length}):\n${lines}\n\nPass one of these as \`model\` to consult's "ask" action.`,
            metadata: { count: all.length, models: all, mode: "permission" } as Record<string, any>,
          }
        }
        const resolved = yield* resolveAllowlist(provider, allowlist)
        const lines = resolved.map((r) => `- ${r}`).join("\n")
        return {
          title: "Consult: available models",
          output:
            resolved.length === 0
              ? `None of the configured consult.models entries resolved to a valid model: ${allowlist.join(", ")}. Check your provider/model_groups configuration.`
              : `Models allowlisted for consult (${resolved.length}):\n${lines}\nPass one of these as \`model\` to consult's "ask" action.`,
          metadata: { count: resolved.length, models: resolved, mode: "explicit" } as Record<string, any>,
        }
      }

      // op.action === "ask"
      const allowedList = explicit
        ? yield* resolveAllowlist(provider, allowlist)
        : yield* allConfiguredModels(provider)
      const allowedSet = new Set(allowedList)

      // Fall back to consult.default_model when the caller omits `model`.
      const targetModel = op.model ?? cfg.consult?.default_model
      if (!targetModel) {
        return yield* Effect.fail(
          new RecoverableError(
            `consult: no model specified and consult.default_model is not configured. Pass a "model" (one of: ${allowedList.join(", ") || "(none — check consult.models)"}) or set consult.default_model in mimocode.json.`,
          ),
        )
      }

      const resolvedTarget = yield* provider.resolveModelRef(targetModel).pipe(Effect.exit)
      if (resolvedTarget._tag !== "Success") {
        return yield* Effect.fail(
          new RecoverableError(
            `consult: could not resolve model "${targetModel}" (${Cause.pretty(resolvedTarget.cause)}). Allowed consult models: ${allowedList.join(", ") || "(none resolvable — check consult.models)"}`,
          ),
        )
      }
      const mdl = resolvedTarget.value
      const resolvedRef = `${mdl.providerID}/${mdl.id}`

      // ENFORCEMENT: never call a model outside the resolved allowlist, no
      // matter how op.model was spelled (provider/model or a group name that
      // happens to resolve to the same concrete model).
      if (!allowedSet.has(resolvedRef)) {
        return yield* Effect.fail(
          new RecoverableError(
            explicit
              ? `consult: model "${targetModel}" (resolved to ${resolvedRef}) is not in the consult allowlist. Allowed models: ${allowedList.join(", ") || "(none)"}. Ask the user to allow it (or add it to consult.models).`
              : `consult: model "${targetModel}" (resolved to ${resolvedRef}) is not a configured model in this install. Configured models: ${allowedList.join(", ") || "(none)"}.`,
          ),
        )
      }

      yield* ctx.ask({
        permission: "consult",
        patterns: [resolvedRef],
        always: ["*"],
        metadata: { model: resolvedRef },
      })

      const language = yield* provider.getLanguage(mdl)
      const wrapped = wrapLanguageModel({
        model: language,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "generate" || args.type === "stream") {
                // @ts-expect-error — mirrors the one-shot side-channel pattern in
                // session/prompt.ts: ProviderTransform.message expects the
                // ModelMessage[] shape but the v3 middleware hands us the raw
                // LanguageModelV3 prompt array, which is structurally compatible.
                args.params.prompt = ProviderTransform.message(args.params.prompt, mdl, {})
              }
              return args.params
            },
          },
        ],
      })

      const result = yield* Effect.tryPromise(() =>
        generateText({
          model: wrapped,
          system: op.system,
          messages: [{ role: "user", content: op.prompt }],
          maxOutputTokens: ProviderTransform.maxOutputTokens(mdl),
          temperature: mdl.capabilities.temperature ? (op.temperature ?? 0.7) : undefined,
          providerOptions: ProviderTransform.providerOptions(mdl, ProviderTransform.smallOptions(mdl)),
          headers: {
            ...mdl.headers,
            "User-Agent": `mimocode/${InstallationVersion}`,
          },
          maxRetries: 1,
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.fail(new RecoverableError(`consult call to ${resolvedRef} failed: ${errorMessage(cause)}`)),
        ),
      )

      return {
        title: `Consulted ${resolvedRef}`,
        output: result.text,
        metadata: {
          model: resolvedRef,
          finishReason: result.finishReason,
        } as Record<string, any>,
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) => run(input, ctx).pipe(Effect.orDie),
    }
  }),
)
