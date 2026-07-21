import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import z from "zod"
import { OAUTH_DUMMY_KEY } from "../auth"
import { copyHeaders, createLoopbackCallback, createOAuthState, createPkce, type OAuthFetch } from "./oauth"

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const ISSUER = "https://auth.x.ai"
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
const API_BASE = "https://api.x.ai/v1"
const OAUTH_BASE = "https://cli-chat-proxy.grok.com/v1"
const SCOPE = "openid profile email offline_access api:access"
const USER_AGENT = "mimocode-xai-oauth/2.0"

const Discovery = z.object({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  device_authorization_endpoint: z.string().optional(),
})
type Discovery = z.infer<typeof Discovery>

const TokenResponse = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
})
type TokenResponse = z.infer<typeof TokenResponse>

export type XaiOAuthAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, string>
}
const refreshes = new Map<string, Promise<XaiOAuthAuth>>()

const GrokCredential = z.object({
  key: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: z.union([z.string(), z.number()]).optional(),
  oidc_client_id: z.string().optional(),
})

export async function discoverXai(fetcher: OAuthFetch = fetch): Promise<Discovery> {
  const response = await fetcher(DISCOVERY_URL, { headers: { "User-Agent": USER_AGENT } })
  if (!response.ok) throw new Error(`xAI OAuth discovery failed (HTTP ${response.status})`)
  return Discovery.parse(await response.json())
}

const expiresAt = (value?: string | number) => {
  if (typeof value === "string") return Date.parse(value)
  if (typeof value !== "number") return Date.now() + 60 * 60 * 1000
  return value > 1e12 ? value : value * 1000
}

export async function readGrokCredentials(file = path.join(os.homedir(), ".grok", "auth.json")) {
  const document = z.record(z.string(), GrokCredential).parse(JSON.parse(await fs.readFile(file, "utf8")))
  const credential = Object.values(document).find(
    (item) => item.key && (!item.oidc_client_id || item.oidc_client_id === CLIENT_ID),
  )
  if (!credential?.key) return undefined
  return {
    access: credential.key,
    refresh: credential.refresh_token ?? "",
    expires: expiresAt(credential.expires_at),
  }
}

async function tokenRequest(endpoint: string, body: URLSearchParams, fetcher: OAuthFetch = fetch) {
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  })
  const tokens = TokenResponse.parse(await response.json())
  if (!response.ok || !tokens.access_token) {
    throw new Error(`xAI OAuth token request failed: ${tokens.error ?? `HTTP ${response.status}`}`)
  }
  return tokens
}

export async function refreshXaiOAuth(auth: XaiOAuthAuth, fetcher: OAuthFetch = fetch) {
  if (auth.expires > Date.now() + 120_000) return auth
  if (!auth.refresh) throw new Error("The Grok OAuth session expired and has no refresh token")
  const pending = refreshes.get(auth.refresh)
  if (pending) return pending
  const task = (async () => {
    const tokens = await tokenRequest(
      (await discoverXai(fetcher)).token_endpoint,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refresh,
        client_id: CLIENT_ID,
      }),
      fetcher,
    )
    return {
      ...auth,
      access: tokens.access_token!,
      refresh: tokens.refresh_token ?? auth.refresh,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    }
  })()
  refreshes.set(auth.refresh, task)
  return task.finally(() => refreshes.delete(auth.refresh))
}

const success = (tokens: TokenResponse) => ({
  type: "success" as const,
  access: tokens.access_token!,
  refresh: tokens.refresh_token ?? "",
  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  metadata: { source: "xai-oauth", oauthBaseURL: OAUTH_BASE },
})

export async function XaiOAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider.xai ??= {}
      config.provider.xai.name ??= "xAI (Grok)"
      config.provider.xai.npm ??= "@ai-sdk/xai"
      config.provider.xai.options ??= { baseURL: API_BASE }
      config.provider.xai.models ??= {}
      config.provider.xai.models["grok-build"] ??= { name: "Grok Build (OAuth)" }
      // Real model id + limits pulled from the official Grok CLI's own cache
      // (~/.grok/models_cache.json, origin cli-chat-proxy.grok.com/v1/models) -
      // "grok-build" is that same CLI's configured default alias (~/.grok/config.toml
      // [models] default = "grok-build"), not a fabricated id; grok-4.5 is the
      // distinct, explicitly selectable frontier model alongside it.
      config.provider.xai.models["grok-4.5"] ??= {
        name: "Grok 4.5",
        reasoning: true,
        tool_call: true,
        limit: { context: 500000, output: 65536 },
      }
    },
    auth: {
      provider: "xai",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type === "api") return { apiKey: auth.key, baseURL: API_BASE }
        if (auth.type !== "oauth") return {}

        const OAUTH_MODEL_IDS = new Set(["grok-build", "grok-4.5"])
        for (const [modelID, model] of Object.entries(provider.models)) {
          if (!OAUTH_MODEL_IDS.has(modelID)) delete provider.models[modelID]
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }

        return {
          apiKey: OAUTH_DUMMY_KEY,
          baseURL: OAUTH_BASE,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const current = await getAuth()
            if (current.type !== "oauth") throw new Error("Grok OAuth credentials were removed")
            const updated = await refreshXaiOAuth(current as XaiOAuthAuth)
            if (updated.access !== current.access || updated.refresh !== current.refresh) {
              await input.client.auth.set({
                path: { id: "xai" },
                body: updated,
              })
            }
            const headers = copyHeaders(init?.headers)
            headers.delete("authorization")
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${updated.access}`)
            headers.set("X-XAI-Token-Auth", "xai-grok-cli")
            // Required or the proxy 426s with "Your Grok CLI version (none) is
            // outdated" - found via the real grok.exe binary's header strings
            // and confirmed live; bump if xAI raises the minimum accepted version.
            headers.set("x-grok-client-version", "0.2.106")
            const requestedModel = (() => {
              try {
                const body = init?.body ? JSON.parse(init.body.toString()) : undefined
                return typeof body?.model === "string" ? body.model : undefined
              } catch {
                return undefined
              }
            })()
            headers.set("x-grok-model-override", requestedModel ?? "grok-build")
            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "Grok OAuth (browser)",
          type: "oauth",
          authorize: async () => {
            const discovery = await discoverXai()
            const pkce = await createPkce()
            const state = createOAuthState()
            const callback = await createLoopbackCallback()
            const url = new URL(discovery.authorization_endpoint)
            url.search = new URLSearchParams({
              response_type: "code",
              client_id: CLIENT_ID,
              redirect_uri: callback.redirectUri,
              scope: SCOPE,
              code_challenge: pkce.challenge,
              code_challenge_method: "S256",
              state,
            }).toString()
            return {
              url: url.toString(),
              method: "auto" as const,
              instructions: "Complete the Grok authorization in your browser.",
              callback: async () => {
                try {
                  const result = await callback.wait
                  if (result.state !== state) throw new Error("xAI OAuth state mismatch")
                  return success(
                    await tokenRequest(
                      discovery.token_endpoint,
                      new URLSearchParams({
                        grant_type: "authorization_code",
                        code: result.code,
                        redirect_uri: callback.redirectUri,
                        client_id: CLIENT_ID,
                        code_verifier: pkce.verifier,
                      }),
                    ),
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
          label: "Grok OAuth (device/headless)",
          type: "oauth",
          authorize: async () => {
            const discovery = await discoverXai()
            if (!discovery.device_authorization_endpoint) {
              throw new Error("xAI does not advertise device authorization")
            }
            const response = await fetch(discovery.device_authorization_endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
              body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
            })
            const device = z
              .object({
                device_code: z.string().optional(),
                user_code: z.string().optional(),
                verification_uri: z.string().optional(),
                verification_uri_complete: z.string().optional(),
                interval: z.number().optional(),
                expires_in: z.number().optional(),
              })
              .parse(await response.json())
            if (!response.ok || !device.device_code || !device.user_code) {
              throw new Error(`xAI device authorization failed (HTTP ${response.status})`)
            }
            return {
              url: device.verification_uri_complete ?? device.verification_uri ?? `${ISSUER}/device`,
              method: "auto" as const,
              instructions: `Enter this Grok device code: ${device.user_code}`,
              callback: async () => {
                const deadline = Date.now() + (device.expires_in ?? 900) * 1000
                const interval = Math.max(device.interval ?? 5, 1) * 1000
                while (Date.now() < deadline) {
                  await sleep(interval)
                  const response = await fetch(discovery.token_endpoint, {
                    method: "POST",
                    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
                    body: new URLSearchParams({
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                      device_code: device.device_code!,
                      client_id: CLIENT_ID,
                    }),
                  })
                  const tokens = TokenResponse.parse(await response.json())
                  if (tokens.error === "authorization_pending" || tokens.error === "slow_down") continue
                  if (response.ok && tokens.access_token) return success(tokens)
                  return { type: "failed" as const }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
        {
          label: "Import official Grok CLI login (~/.grok/auth.json)",
          type: "oauth",
          authorize: async () => ({
            url: "",
            method: "auto" as const,
            instructions: "Importing the official Grok CLI OAuth session.",
            callback: async () => {
              try {
                const credential = await readGrokCredentials()
                if (!credential) return { type: "failed" as const }
                return {
                  type: "success" as const,
                  ...credential,
                  metadata: { source: "grok-cli", oauthBaseURL: OAUTH_BASE },
                }
              } catch {
                return { type: "failed" as const }
              }
            },
          }),
        },
        {
          label: "xAI API key (console.x.ai)",
          type: "api",
          authorize: async () => ({ type: "success" as const, key: "" }),
        },
      ],
    },
  }
}
