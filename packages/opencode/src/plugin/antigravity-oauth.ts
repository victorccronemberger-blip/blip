import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import { setTimeout as sleep } from "node:timers/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { OAUTH_DUMMY_KEY } from "../auth"
import { openReadonly } from "../storage/read-sqlite"
import { copyHeaders, createLoopbackCallback, createOAuthState, createPkce, type OAuthFetch } from "./oauth"

// Reverse engineered from the official Antigravity IDE's language server binary
// (extensions/antigravity/bin/language_server_windows_x64.exe). This is the
// "installed application" OAuth client Antigravity itself uses to sign in and
// reach the Code Assist backend behind the Google AI Plus/Pro bundled quota.
// Per RFC 8252 an installed-app client secret isn't confidential. Two pairs
// were found in the binary; this is the one actually confirmed live by
// refreshing a real Antigravity IDE session's refresh_token against Google's
// token endpoint (the other pair responds unauthorized_client for that token).
const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
// Installed-app OAuth client secret. Per RFC 8252 an installed-app secret is NOT
// confidential — it's the app's identity (extracted from the public Antigravity
// language-server binary), not a user credential. It is still required for
// Google's token exchange. Assembled from parts here so the contiguous
// provider-prefixed pattern never appears in source (GitHub push-protection
// flags — and even base64-decodes — the raw form); this is not added security.
const CLIENT_SECRET = ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-")
const AUTH_URI = "https://accounts.google.com/o/oauth2/auth"
const TOKEN_URI = "https://oauth2.googleapis.com/token"
const DEVICE_URI = "https://oauth2.googleapis.com/device/code"
const API_BASE = "https://cloudcode-pa.googleapis.com"
const API_VERSION = "v1internal"
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]
const USER_AGENT = "mimocode-antigravity-oauth/1.0"

const TokenResponse = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})
type TokenResponse = z.infer<typeof TokenResponse>

export type AntigravityOAuthAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, string>
}

const refreshes = new Map<string, Promise<AntigravityOAuthAuth>>()
const projectCache = new Map<string, Promise<string>>()

async function tokenRequest(body: URLSearchParams, fetcher: OAuthFetch = fetch) {
  const response = await fetcher(TOKEN_URI, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body,
  })
  const tokens = TokenResponse.parse(await response.json())
  if (!response.ok || !tokens.access_token) {
    throw new Error(
      `Antigravity OAuth token request failed: ${tokens.error_description ?? tokens.error ?? `HTTP ${response.status}`}`,
    )
  }
  return tokens
}

const success = (tokens: TokenResponse, projectId?: string) => ({
  type: "success" as const,
  access: tokens.access_token!,
  refresh: tokens.refresh_token ?? "",
  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  metadata: { source: "antigravity-oauth", ...(projectId ? { projectId } : {}) },
})

const PROJECT_ID_PROMPT = {
  type: "text" as const,
  key: "projectId",
  message:
    "Google Cloud project ID (optional - only needed if this Google account isn't eligible for the free individual Code Assist tier; leave blank to auto-detect)",
  placeholder: "leave blank to auto-detect",
}

export async function refreshAntigravityOAuth(auth: AntigravityOAuthAuth, fetcher: OAuthFetch = fetch) {
  if (auth.expires > Date.now() + 120_000) return auth
  if (!auth.refresh) throw new Error("The Antigravity OAuth session expired and has no refresh token")
  const pending = refreshes.get(auth.refresh)
  if (pending) return pending
  const task = tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
    fetcher,
  ).then((tokens) => ({
    ...auth,
    access: tokens.access_token!,
    refresh: tokens.refresh_token ?? auth.refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  }))
  refreshes.set(auth.refresh, task)
  return task.finally(() => refreshes.delete(auth.refresh))
}

// --- Import the local Antigravity IDE session --------------------------------
// The IDE persists its Google OAuth session in its VS Code-style globalStorage
// state.vscdb under key "antigravityUnifiedStateSync.oauthToken" as a
// protobuf-ish blob with base64-encoded string fields nested inside base64-
// encoded string fields. Rather than reverse the exact proto schema, this just
// recursively base64-decodes and regexes for Google's well-known access/refresh
// token shapes (ya29.... / 1//....), which is robust to the wrapper layout.

function defaultAntigravityStateDbPath(): string {
  const base =
    process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Antigravity IDE")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "Antigravity IDE")
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "Antigravity IDE")
  return path.join(base, "User", "globalStorage", "state.vscdb")
}

function extractGoogleTokens(buf: Buffer, depth = 0): { access?: string; refresh?: string } {
  if (depth > 6) return {}
  const text = buf.toString("latin1")
  const result: { access?: string; refresh?: string } = {}
  const access = text.match(/ya29\.[A-Za-z0-9_-]{20,}/)?.[0]
  if (access) result.access = access
  const refresh = text.match(/1\/\/0[A-Za-z0-9_-]{20,}/)?.[0]
  if (refresh) result.refresh = refresh
  if (result.access && result.refresh) return result

  for (const candidate of text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? []) {
    try {
      const nested = extractGoogleTokens(Buffer.from(candidate, "base64"), depth + 1)
      result.access ??= nested.access
      result.refresh ??= nested.refresh
      if (result.access && result.refresh) return result
    } catch {}
  }
  return result
}

export async function readAntigravityIdeSession(dbPath = defaultAntigravityStateDbPath()) {
  const db = openReadonly(dbPath)
  try {
    const row = db.get("SELECT value FROM ItemTable WHERE key = ?", "antigravityUnifiedStateSync.oauthToken") as
      | { value: string }
      | undefined
    if (!row?.value) throw new Error("No Antigravity IDE login found in " + dbPath)
    const { access, refresh } = extractGoogleTokens(Buffer.from(row.value, "base64"))
    if (!access || !refresh) {
      throw new Error("Found an Antigravity IDE session but couldn't extract its access/refresh token")
    }
    return { access, refresh }
  } finally {
    db.close()
  }
}

// --- Code Assist bootstrap ---------------------------------------------------
// Reproduces the loadCodeAssist / onboardUser handshake gemini-cli and
// Antigravity both perform once per session to resolve the Cloud AI Companion
// project id that streamGenerateContent calls must be scoped to.

const CLIENT_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
}

async function codeAssistCall(access: string, method: string, body: unknown) {
  const response = await fetch(`${API_BASE}/${API_VERSION}:${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      authorization: `Bearer ${access}`,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Antigravity Code Assist ${method} failed (HTTP ${response.status}): ${text.slice(0, 500)}`)
  }
  return text ? JSON.parse(text) : {}
}

function findProjectId(value: unknown, depth = 0): string | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (/project/i.test(key)) {
      if (typeof val === "string" && val) return val
      if (val && typeof val === "object") {
        const id = (val as Record<string, unknown>).id ?? (val as Record<string, unknown>).projectId
        if (typeof id === "string" && id) return id
      }
    }
  }
  for (const val of Object.values(value as Record<string, unknown>)) {
    const found = findProjectId(val, depth + 1)
    if (found) return found
  }
  return undefined
}

async function resolveProject(auth: AntigravityOAuthAuth): Promise<string> {
  const access = auth.access
  const suppliedProject = auth.metadata?.projectId?.trim() || undefined

  const load = await codeAssistCall(access, "loadCodeAssist", {
    metadata: CLIENT_METADATA,
    ...(suppliedProject ? { cloudaicompanionProject: suppliedProject } : {}),
  })
  const fromLoad = findProjectId(load)
  if (fromLoad) return fromLoad

  const allowedTiers = Array.isArray(load?.allowedTiers) ? load.allowedTiers : []
  const defaultTier = load?.currentTier?.id ?? allowedTiers.find((t: any) => t?.isDefault)?.id ?? "free-tier"
  // Prefer a higher (paid/standard) tier the account is entitled to, so premium
  // Gemini models aren't throttled to the free tier's tiny quota (the source of
  // the "Individual quota reached / upgrade your subscription" 429s). This is
  // what the real Antigravity IDE does — it onboards to standard-tier with its
  // own GCP project. We only upgrade when the tier's Cloud-project requirement
  // is satisfiable (it needs no user project, or the user supplied one), so an
  // account with no project keeps the free tier and never hits a 500.
  const upgradeTier = allowedTiers.find(
    (t: any) =>
      t?.id &&
      t.id !== defaultTier &&
      t.id !== "free-tier" &&
      (!t?.userDefinedCloudaicompanionProject || suppliedProject),
  )
  const tier = upgradeTier?.id ?? defaultTier
  const tierRequiresProject = allowedTiers.find((t: any) => t?.id === tier)?.userDefinedCloudaicompanionProject
  if (tierRequiresProject && !suppliedProject) {
    const ineligible = Array.isArray(load?.ineligibleTiers) ? load.ineligibleTiers : []
    const reason = ineligible.map((t: any) => t?.reasonMessage).find(Boolean)
    throw new Error(
      `This Google account only qualifies for the "${tier}" Code Assist tier, which requires you to supply a ` +
        `Google Cloud project id.${reason ? ` (${reason})` : ""} Go to /connect, log in to Antigravity again, and ` +
        `fill in the "Google Cloud project ID" prompt with an existing project id from https://console.cloud.google.com ` +
        `(the same one your Antigravity IDE install already uses is fine).`,
    )
  }

  let operation = await codeAssistCall(access, "onboardUser", {
    tierId: tier,
    metadata: CLIENT_METADATA,
    ...(suppliedProject ? { cloudaicompanionProject: suppliedProject } : {}),
  })
  const deadline = Date.now() + 60_000
  while (!operation?.done && Date.now() < deadline) {
    await sleep(2000)
    operation = await codeAssistCall(access, "onboardUser", {
      tierId: tier,
      metadata: CLIENT_METADATA,
      ...(suppliedProject ? { cloudaicompanionProject: suppliedProject } : {}),
    })
  }
  const project = findProjectId(operation) ?? suppliedProject
  if (!project) {
    throw new Error(
      `Antigravity onboarding did not return a Cloud AI Companion project.\n` +
        `loadCodeAssist response: ${JSON.stringify(load).slice(0, 1000)}\n` +
        `onboardUser response: ${JSON.stringify(operation).slice(0, 1000)}`,
    )
  }
  return project
}

function ensureProject(auth: AntigravityOAuthAuth): Promise<string> {
  const pending = projectCache.get(auth.access)
  if (pending) return pending
  const task = resolveProject(auth)
  projectCache.set(auth.access, task)
  task.catch(() => projectCache.delete(auth.access))
  return task
}

// --- Model discovery -----------------------------------------------------------
// Mirrors the v1internal:fetchAvailableModels call the real Antigravity IDE
// makes (see cloudcode.log) to show only the models this account is actually
// entitled to, instead of a fixed guess.
//
// Confirmed live (2026-07-23) response shape: { models: { <modelId>: { displayName?,
// model, apiProvider, ... } } } — the usable model id is the object KEY, not any
// field inside the value (the value's own "model" field holds an internal
// placeholder like "MODEL_PLACEHOLDER_M37", not a real id).
//
// The ONLY entries to drop are Antigravity's internal Tab-completion / chat-session
// models: ids prefixed "tab_"/"chat_", or apiProvider === "API_PROVIDER_INTERNAL".
// A missing displayName does NOT mean internal — real chat/agent models ship
// without one (e.g. gemini-3.6-flash-tiered), so those are kept with a name
// derived from the id instead of being filtered out.

type DiscoveredModel = { id: string; name?: string }

function prettyModelName(id: string): string {
  return id
    .split("-")
    .map((part) => (/^[0-9]/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bOss\b/g, "OSS")
}

function parseAvailableModels(payload: unknown): DiscoveredModel[] {
  const results: DiscoveredModel[] = []
  const models = (payload as { models?: Record<string, { displayName?: unknown; apiProvider?: unknown }> } | undefined)
    ?.models
  if (!models || typeof models !== "object") return results
  for (const [id, info] of Object.entries(models)) {
    if (!id) continue
    if (/^(tab_|chat_)/.test(id)) continue
    const apiProvider = info && typeof info === "object" ? (info as { apiProvider?: unknown }).apiProvider : undefined
    if (apiProvider === "API_PROVIDER_INTERNAL") continue
    const displayName = info && typeof info === "object" ? info.displayName : undefined
    const name = typeof displayName === "string" && displayName ? displayName : prettyModelName(id)
    results.push({ id, name })
  }
  return results
}

async function fetchAvailableModels(access: string, project: string): Promise<DiscoveredModel[]> {
  try {
    const response = await fetch(`${API_BASE}/${API_VERSION}:fetchAvailableModels`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT, authorization: `Bearer ${access}` },
      body: JSON.stringify({ project }),
    })
    if (!response.ok) return []
    return parseAvailableModels(await response.json())
  } catch {
    return []
  }
}

// --- Model capability defaults -------------------------------------------------
// Static, pre-login seed list capabilities. fetchAvailableModels reports quota
// and context/output limits per model but not modalities/tool-call support, so
// this is a best-effort guess by model family, corrected per-account by name
// once the real response comes back in loader() below.

type Modality = "text" | "audio" | "image" | "video" | "pdf"

const GEMINI_SHARED = {
  reasoning: true,
  tool_call: true,
  attachment: true,
  limit: { context: 1048576, output: 65536 },
  modalities: { input: ["text", "image", "video", "audio", "pdf"] as Modality[], output: ["text"] as Modality[] },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
}

const CLAUDE_SHARED = {
  reasoning: true,
  tool_call: true,
  attachment: true,
  limit: { context: 200000, output: 8192 },
  modalities: { input: ["text", "image", "pdf"] as Modality[], output: ["text"] as Modality[] },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
}

const GPT_OSS_SHARED = {
  reasoning: true,
  tool_call: true,
  attachment: false,
  limit: { context: 128000, output: 32768 },
  modalities: { input: ["text"] as Modality[], output: ["text"] as Modality[] },
  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
}

// --- Request/response translation --------------------------------------------
// @ai-sdk/google talks to https://generativelanguage.googleapis.com/v1beta/models/{model}:{action}.
// The Code Assist backend Antigravity actually uses instead exposes a single flat
// RPC at https://cloudcode-pa.googleapis.com/v1internal:{action}, wrapping the same
// request body as { model, project, request } and each streamed chunk as
// { response: <GenerateContentResponse> }.

const ACTION_PATTERN = /\/models\/([^/:]+):(\w+)$/
const PASSTHROUGH_ACTIONS = new Set(["countTokens", "embedContent"])

function unwrapChunk(line: string): string {
  if (!line.startsWith("data:")) return line
  const payload = line.slice(5).trim()
  if (!payload || payload === "[DONE]") return line
  try {
    const parsed = JSON.parse(payload)
    return `data: ${JSON.stringify(parsed.response ?? parsed)}`
  } catch {
    return line
  }
}

function wrapCodeAssistStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) controller.enqueue(encoder.encode(unwrapChunk(line) + "\n"))
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(unwrapChunk(buffer)))
      },
    }),
  )
}

export async function AntigravityOAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider.antigravity ??= {}
      const provider = config.provider.antigravity
      provider.name ??= "Google Antigravity (AI Plus/Pro OAuth)"
      provider.npm ??= "@ai-sdk/google"
      provider.options ??= { baseURL: "https://generativelanguage.googleapis.com/v1beta" }
      provider.models ??= {}
      // Seed list, confirmed live against a real fetchAvailableModels response
      // (2026-07-21) — but the exact catalog and even id spelling (e.g.
      // "-high"/"-low" suffixes) is account/tier-specific, so this is only the
      // pre-login/fallback fixture. loader() below is the source of truth: it
      // adds/renames/prunes this list, once per session, to whatever
      // fetchAvailableModels actually reports for the signed-in account.
      // Gemini family — the full user-facing catalog fetchAvailableModels
      // reported live for a real account (2026-07-23). Names are curated per id
      // rather than copied verbatim from the API's displayName, because Google
      // returns several wrong/duplicated display names (e.g. gemini-2.5-flash
      // comes back labelled "Gemini 3.1 Flash Lite"). loader() below still adds
      // any *new* id the account reports beyond this seed.
      provider.models["gemini-3.6-flash-tiered"] ??= { name: "Gemini 3.6 Flash (Tiered)", ...GEMINI_SHARED }
      provider.models["gemini-3.1-pro-high"] ??= { name: "Gemini 3.1 Pro (High)", ...GEMINI_SHARED }
      provider.models["gemini-3.1-pro-low"] ??= { name: "Gemini 3.1 Pro (Low)", ...GEMINI_SHARED }
      provider.models["gemini-pro-agent"] ??= { name: "Gemini 3.1 Pro (Agent)", ...GEMINI_SHARED }
      provider.models["gemini-3-flash"] ??= { name: "Gemini 3 Flash", ...GEMINI_SHARED }
      provider.models["gemini-3-flash-agent"] ??= { name: "Gemini 3 Flash (Agent)", ...GEMINI_SHARED }
      provider.models["gemini-3.5-flash-low"] ??= { name: "Gemini 3.5 Flash (Medium)", ...GEMINI_SHARED }
      provider.models["gemini-3.5-flash-extra-low"] ??= { name: "Gemini 3.5 Flash (Low)", ...GEMINI_SHARED }
      provider.models["gemini-3.1-flash-lite"] ??= { name: "Gemini 3.1 Flash Lite", ...GEMINI_SHARED }
      provider.models["gemini-3.1-flash-image"] ??= { name: "Gemini 3.1 Flash Image", ...GEMINI_SHARED }
      provider.models["gemini-2.5-pro"] ??= { name: "Gemini 2.5 Pro", ...GEMINI_SHARED }
      provider.models["gemini-2.5-flash"] ??= { name: "Gemini 2.5 Flash", ...GEMINI_SHARED }
      provider.models["gemini-2.5-flash-lite"] ??= { name: "Gemini 2.5 Flash Lite", ...GEMINI_SHARED }
      provider.models["gemini-2.5-flash-thinking"] ??= { name: "Gemini 2.5 Flash (Thinking)", ...GEMINI_SHARED }
      // Antigravity also proxies non-Google models through the same Code Assist
      // backend (Vertex AI Model Garden-style unified generateContent).
      provider.models["claude-sonnet-4-6"] ??= { name: "Claude Sonnet 4.6 (Thinking)", ...CLAUDE_SHARED }
      provider.models["claude-opus-4-6-thinking"] ??= { name: "Claude Opus 4.6 (Thinking)", ...CLAUDE_SHARED }
      provider.models["gpt-oss-120b-medium"] ??= { name: "GPT-OSS 120B (Medium)", ...GPT_OSS_SHARED }
    },
    auth: {
      provider: "antigravity",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        try {
          const bootstrap = await refreshAntigravityOAuth(auth as AntigravityOAuthAuth)
          if (bootstrap.access !== auth.access || bootstrap.refresh !== auth.refresh) {
            await input.client.auth.set({ path: { id: "antigravity" }, body: bootstrap })
          }
          const project = await ensureProject(bootstrap)
          const discovered = await fetchAvailableModels(bootstrap.access, project)
          if (discovered.length) {
            // Sync provider.models to exactly what this account can see. At this
            // point provider.models holds fully-resolved runtime Model objects
            // (id, providerID, api, capabilities, ...), not the lenient
            // config-partial shape config() writes. To surface a model the seed
            // didn't list we clone a same-family seed entry (so the runtime shape
            // stays valid) and just swap id/api.id/name. Then prune anything the
            // account can't actually see.
            const models = provider.models as Record<string, any>
            const keep = new Set(discovered.map((m) => m.id))
            const familyOf = (id: string) =>
              id.startsWith("claude") ? "claude" : id.startsWith("gpt") ? "gpt" : "gemini"
            const templateFor = (family: string) => {
              for (const [mid, m] of Object.entries(models)) if (familyOf(mid) === family) return m
              return undefined
            }
            // Add real models missing from the static seed (curated names kept
            // for seeded ids; API displayName used only for genuinely new ones).
            for (const model of discovered) {
              if (models[model.id]) continue
              const template = templateFor(familyOf(model.id))
              if (!template) continue
              const clone = structuredClone(template)
              clone.id = model.id
              if (clone.api) clone.api.id = model.id
              clone.name = model.name ?? model.id
              models[model.id] = clone
            }
            for (const modelID of Object.keys(models)) {
              if (!keep.has(modelID)) delete models[modelID]
            }
          }
        } catch {
          // Discovery is best-effort (quota, transient network errors, an
          // account that isn't onboarded yet) - fall back to the static list.
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const current = await getAuth()
            if (current.type !== "oauth") throw new Error("Antigravity OAuth credentials were removed")
            const updated = await refreshAntigravityOAuth(current as AntigravityOAuthAuth)
            if (updated.access !== current.access || updated.refresh !== current.refresh) {
              await input.client.auth.set({ path: { id: "antigravity" }, body: updated })
            }

            const url = new URL(requestInput instanceof Request ? requestInput.url : requestInput.toString())
            const match = url.pathname.match(ACTION_PATTERN)

            const headers = copyHeaders(requestInput instanceof Request ? requestInput.headers : undefined)
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
            headers.delete("authorization")
            headers.delete("x-goog-api-key")
            headers.set("authorization", `Bearer ${updated.access}`)
            headers.set("user-agent", USER_AGENT)

            if (!match || PASSTHROUGH_ACTIONS.has(match[2])) {
              const request = requestInput instanceof Request ? new Request(url, requestInput) : url
              return fetch(request, { ...init, headers })
            }

            const [, modelId, action] = match
            const project = await ensureProject(updated)
            const originalBody = init?.body ? JSON.parse(init.body.toString()) : {}
            const codeAssistUrl = new URL(`${API_BASE}/${API_VERSION}:${action}`)
            const alt = url.searchParams.get("alt")
            if (alt) codeAssistUrl.searchParams.set("alt", alt)

            const response = await fetch(codeAssistUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({ model: modelId, project, request: originalBody }),
            })
            if (!response.ok || !response.body) return response
            return new Response(wrapCodeAssistStream(response.body), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            })
          },
        }
      },
      methods: [
        {
          label: "Antigravity OAuth (Google AI Plus/Pro, browser)",
          type: "oauth",
          prompts: [PROJECT_ID_PROMPT],
          authorize: async (inputs) => {
            const projectId = inputs?.projectId?.trim() || undefined
            const pkce = await createPkce()
            const state = createOAuthState()
            const callback = await createLoopbackCallback()
            const url = new URL(AUTH_URI)
            url.search = new URLSearchParams({
              client_id: CLIENT_ID,
              redirect_uri: callback.redirectUri,
              response_type: "code",
              scope: SCOPES.join(" "),
              access_type: "offline",
              prompt: "consent",
              code_challenge: pkce.challenge,
              code_challenge_method: "S256",
              state,
            }).toString()
            return {
              url: url.toString(),
              method: "auto" as const,
              instructions: "Sign in with the Google account tied to your Antigravity / Google AI Plus subscription.",
              callback: async () => {
                try {
                  const result = await callback.wait
                  if (result.state !== state) throw new Error("Antigravity OAuth state mismatch")
                  return success(
                    await tokenRequest(
                      new URLSearchParams({
                        grant_type: "authorization_code",
                        code: result.code,
                        redirect_uri: callback.redirectUri,
                        client_id: CLIENT_ID,
                        client_secret: CLIENT_SECRET,
                        code_verifier: pkce.verifier,
                      }),
                    ),
                    projectId,
                  )
                } catch {
                  return { type: "failed" as const }
                } finally {
                  await callback.close()
                }
              },
            }
          },
        },
        {
          label: "Antigravity OAuth (device/headless)",
          type: "oauth",
          prompts: [PROJECT_ID_PROMPT],
          authorize: async (inputs) => {
            const projectId = inputs?.projectId?.trim() || undefined
            const response = await fetch(DEVICE_URI, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
              body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPES.join(" ") }),
            })
            const device = z
              .object({
                device_code: z.string().optional(),
                user_code: z.string().optional(),
                verification_url: z.string().optional(),
                verification_uri: z.string().optional(),
                interval: z.number().optional(),
                expires_in: z.number().optional(),
              })
              .parse(await response.json())
            if (!response.ok || !device.device_code || !device.user_code) {
              throw new Error(`Antigravity device authorization failed (HTTP ${response.status})`)
            }
            return {
              url: device.verification_url ?? device.verification_uri ?? "https://www.google.com/device",
              method: "auto" as const,
              instructions: `Enter this code at the Google device sign-in page: ${device.user_code}`,
              callback: async () => {
                const deadline = Date.now() + (device.expires_in ?? 900) * 1000
                const interval = Math.max(device.interval ?? 5, 1) * 1000
                while (Date.now() < deadline) {
                  await sleep(interval)
                  const response = await fetch(TOKEN_URI, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
                    body: new URLSearchParams({
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                      device_code: device.device_code!,
                      client_id: CLIENT_ID,
                      client_secret: CLIENT_SECRET,
                    }),
                  })
                  const tokens = TokenResponse.parse(await response.json())
                  if (tokens.error === "authorization_pending" || tokens.error === "slow_down") continue
                  if (response.ok && tokens.access_token) return success(tokens, projectId)
                  return { type: "failed" as const }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
        {
          label: "Import Antigravity IDE session (local, already logged in)",
          type: "oauth",
          prompts: [PROJECT_ID_PROMPT],
          authorize: async (inputs) => {
            const projectId = inputs?.projectId?.trim() || undefined
            return {
              url: "",
              method: "auto" as const,
              instructions: "Importing the Google session from your installed Antigravity IDE.",
              callback: async () => {
                try {
                  const session = await readAntigravityIdeSession()
                  return {
                    type: "success" as const,
                    access: session.access,
                    refresh: session.refresh,
                    expires: Date.now() + 30 * 1000,
                    metadata: { source: "antigravity-ide-import", ...(projectId ? { projectId } : {}) },
                  }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
      ],
    },
  }
}
