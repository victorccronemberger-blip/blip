import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { RecoverableError } from "./recoverable"
import DESCRIPTION from "./provider-manage.txt"
import { Auth } from "../auth"
import { Provider } from "@/provider"
import { Config } from "../config"
import { errorMessage } from "@/util/error"

const id = "providers"

const listSchema = z.strictObject({
  action: z
    .literal("list_connected")
    .describe("List the ACTIVE providers (in the model list) and the ones currently REMOVED (hidden), so you can remove or restore them."),
})

const removeSchema = z.strictObject({
  action: z
    .literal("remove")
    .describe("Hide one or more providers so their models stop cluttering the model list. Reversible — restore later with the 'enable' action. Keeps saved keys/config intact."),
  providers: z
    .array(z.string().min(1))
    .min(1)
    .describe("Active provider IDs to remove (from list_connected), e.g. [\"openai\", \"google\"]."),
})

const enableSchema = z.strictObject({
  action: z
    .literal("enable")
    .describe("Restore (un-remove) one or more previously removed providers so they show up again."),
  providers: z
    .array(z.string().min(1))
    .min(1)
    .describe("Removed provider IDs to restore (the removed list from list_connected)."),
})

export const ProviderManageTool = Tool.define(
  id,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service

    const parameters = z.strictObject({
      // .meta({ type: "object" }) — same rationale as actor.ts/consult.ts: keeps
      // the emitted JSON schema's `operation` node typed so models nest it.
      operation: z.discriminatedUnion("action", [listSchema, removeSchema, enableSchema]).meta({ type: "object" }),
    })

    const run = Effect.fn("ProviderManageTool.execute")(function* (input: z.infer<typeof parameters>, ctx: Tool.Context) {
      const op = input.operation
      // Active providers = whatever is currently in the model list (provider.list
      // already excludes disabled ones). Removed = config.disabled_providers.
      const providers = (yield* provider.list().pipe(Effect.orElseSucceed(() => ({})))) as Record<
        string,
        { source?: string; models?: Record<string, unknown> }
      >
      const authAll = (yield* auth.all().pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      const cfg = yield* config.get()
      const disabledList = [...new Set(cfg.disabled_providers ?? [])]
      const ids = Object.keys(providers).sort()

      if (op.action === "list_connected") {
        const activeLines = ids.map((pid) => {
          const info = providers[pid]
          const source = info?.source ?? "unknown"
          const n = Object.keys(info?.models ?? {}).length
          const savedKey = authAll[pid] ? ", saved key" : ""
          return `- ${pid} (${source}${savedKey}, ${n} model${n === 1 ? "" : "s"})`
        })
        const removedLines = disabledList.sort().map((pid) => `- ${pid}`)
        const output = [
          `Active providers (${ids.length}):`,
          activeLines.length ? activeLines.join("\n") : "  (none)",
          "",
          `Removed / hidden (${disabledList.length}):`,
          removedLines.length ? removedLines.join("\n") : "  (none)",
          "",
          `Use "remove" to hide an active provider (reversible), or "enable" to restore a removed one.`,
        ].join("\n")
        return {
          title: `Providers: ${ids.length} active, ${disabledList.length} removed`,
          output,
          metadata: { active: ids, removed: disabledList } as Record<string, any>,
        }
      }

      if (op.action === "enable") {
        const requested = [...new Set(op.providers)]
        const known = requested.filter((p) => disabledList.includes(p))
        const unknown = requested.filter((p) => !disabledList.includes(p))
        if (known.length === 0) {
          return yield* Effect.fail(
            new RecoverableError(
              `providers: none of ${requested.join(", ")} are currently removed. Removed: ${disabledList.join(", ") || "(none)"}.`,
            ),
          )
        }
        const next = disabledList.filter((p) => !known.includes(p))
        const updated = yield* config.update({ disabled_providers: next } as any).pipe(Effect.exit)
        if (updated._tag !== "Success") {
          return yield* Effect.fail(
            new RecoverableError(`providers: failed to restore ${known.join(", ")} (config write error): ${errorMessage((updated as any).cause)}`),
          )
        }
        const parts = [`Restored: ${known.join(", ")}.`]
        if (unknown.length) parts.push(`Not removed (skipped): ${unknown.join(", ")}.`)
        parts.push("They're back in the list; a restart fully refreshes it.")
        return {
          title: `Restored ${known.length} provider${known.length === 1 ? "" : "s"}`,
          output: parts.join("\n"),
          metadata: { restored: known, skipped: unknown, disabled_providers: next } as Record<string, any>,
        }
      }

      // op.action === "remove"
      const requested = [...new Set(op.providers)]
      const known = requested.filter((p) => ids.includes(p))
      const unknown = requested.filter((p) => !ids.includes(p))

      if (known.length === 0) {
        return yield* Effect.fail(
          new RecoverableError(
            `providers: none of ${requested.join(", ")} are active. Active: ${ids.join(", ") || "(none)"}. Call list_connected first.`,
          ),
        )
      }

      yield* ctx.ask({
        permission: "providers",
        patterns: known,
        always: ["*"],
        metadata: { action: "remove", providers: known },
      })

      // "Remove" = make the provider clean/unregistered: delete its saved API key
      // (harmless no-op if there's none) AND hide it via disabled_providers.
      // provider.ts drops disabled providers from the state, so they vanish from
      // the model list and /connect. Still reversible: `enable` un-hides it and it
      // comes back as a fresh, keyless provider ready to connect again.
      for (const pid of known) {
        yield* auth.remove(pid).pipe(Effect.exit)
      }
      const next = [...new Set([...disabledList, ...known])]
      const updated = yield* config.update({ disabled_providers: next } as any).pipe(Effect.exit)
      if (updated._tag !== "Success") {
        return yield* Effect.fail(
          new RecoverableError(`providers: cleared keys for ${known.join(", ")} but failed to hide them (config write error): ${errorMessage((updated as any).cause)}`),
        )
      }

      const parts = [`Removed (key cleared + hidden): ${known.join(", ")}.`]
      if (unknown.length) parts.push(`Not active (skipped): ${unknown.join(", ")}.`)
      parts.push("Reversible — restore any with the 'enable' action (comes back keyless, ready to reconnect). A restart fully refreshes the model list.")
      return {
        title: `Removed ${known.length} provider${known.length === 1 ? "" : "s"}`,
        output: parts.join("\n"),
        metadata: { removed: known, skipped: unknown, disabled_providers: next } as Record<string, any>,
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (input: z.infer<typeof parameters>, ctx: Tool.Context) => run(input, ctx).pipe(Effect.orDie),
    }
  }),
)
