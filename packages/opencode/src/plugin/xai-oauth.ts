/**
 * xAI / Grok auth plugin for MiMoCode.
 *
 * Methods:
 *  1) OAuth device-code (SuperGrok / X Premium+ style) against auth.x.ai
 *  2) Import existing tokens from ~/.codex/xai_oauth.json (Codex Grok setup)
 *  3) Paste XAI_API_KEY
 *
 * OAuth access tokens are used as Bearer apiKey against https://api.x.ai/v1.
 * Note: some SuperGrok accounts still get 403 on the API surface without
 * console credits — fall back to a console API key in that case.
 */
import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../auth"
import os from "os"
import path from "path"
import fs from "fs/promises"

const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"
const ISSUER = "https://auth.x.ai"
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`
const API_BASE = "https://api.x.ai/v1"
const UA = "mimocode-xai-oauth/1.0"

type Discovery = { token_endpoint: string; device_authorization_endpoint: string }

async function discover(): Promise<Discovery> {
  const res = await fetch(DISCOVERY, { headers: { "User-Agent": UA } })
  if (!res.ok) throw new Error(`xAI discovery failed: HTTP ${res.status}`)
  const doc = (await res.json()) as Record<string, unknown>
  const token = doc.token_endpoint
  const device = doc.device_authorization_endpoint
  if (typeof token !== "string" || typeof device !== "string") {
    throw new Error("xAI discovery missing endpoints")
  }
  return { token_endpoint: token, device_authorization_endpoint: device }
}

async function readCodexStore(): Promise<{
  access_token?: string
  refresh_token?: string
  expires_at?: number
  client_id?: string
} | null> {
  const p = path.join(os.homedir(), ".codex", "xai_oauth.json")
  try {
    const raw = await fs.readFile(p, "utf8")
    return JSON.parse(raw) as {
      access_token?: string
      refresh_token?: string
      expires_at?: number
      client_id?: string
    }
  } catch {
    return null
  }
}

async function refreshIfNeeded(auth: {
  type: string
  access?: string
  refresh?: string
  expires?: number
}): Promise<{ access: string; refresh?: string; expires?: number } | null> {
  if (auth.type !== "oauth" || !auth.access) return null
  const skew = 120_000
  if (auth.expires && Date.now() < auth.expires - skew) {
    return { access: auth.access, refresh: auth.refresh, expires: auth.expires }
  }
  if (!auth.refresh) return { access: auth.access, refresh: auth.refresh, expires: auth.expires }
  try {
    const { token_endpoint } = await discover()
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
    })
    const res = await fetch(token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body,
    })
    if (!res.ok) return { access: auth.access, refresh: auth.refresh, expires: auth.expires }
    const tokens = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!tokens.access_token) return { access: auth.access, refresh: auth.refresh, expires: auth.expires }
    return {
      access: tokens.access_token,
      refresh: tokens.refresh_token ?? auth.refresh,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    }
  } catch {
    return { access: auth.access, refresh: auth.refresh, expires: auth.expires }
  }
}

export async function XaiOAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider.xai ??= {
        name: "xAI (Grok)",
        npm: "@ai-sdk/xai",
        options: { baseURL: API_BASE },
        models: {
          "grok-4": { name: "Grok 4" },
          "grok-4.5": { name: "Grok 4.5" },
          "grok-3": { name: "Grok 3" },
          "grok-3-mini": { name: "Grok 3 Mini" },
          "grok-2": { name: "Grok 2" },
        },
      }
    },
    auth: {
      provider: "xai",
      async loader(getAuth) {
        const auth = (await getAuth()) as {
          type: string
          key?: string
          access?: string
          refresh?: string
          expires?: number
        }
        if (!auth) return {}

        if (auth.type === "api" && auth.key) {
          return { apiKey: auth.key, baseURL: API_BASE }
        }

        if (auth.type === "oauth") {
          const refreshed = await refreshIfNeeded(auth)
          const token = refreshed?.access ?? auth.access
          if (!token) return {}
          return {
            apiKey: token,
            baseURL: API_BASE,
            async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
              const headers = new Headers()
              if (init?.headers) {
                if (init.headers instanceof Headers) {
                  init.headers.forEach((v, k) => headers.set(k, v))
                } else if (Array.isArray(init.headers)) {
                  for (const [k, v] of init.headers) if (v !== undefined) headers.set(k, String(v))
                } else {
                  for (const [k, v] of Object.entries(init.headers)) {
                    if (v !== undefined) headers.set(k, String(v))
                  }
                }
              }
              // Strip dummy / wrong schemes and force Bearer OAuth token.
              headers.delete("authorization")
              headers.delete("x-api-key")
              headers.set("authorization", `Bearer ${token}`)
              return fetch(requestInput, { ...init, headers })
            },
          }
        }

        return {}
      },
      methods: [
        {
          label: "xAI OAuth (device code / SuperGrok)",
          type: "oauth" as const,
          authorize: async () => {
            const { token_endpoint, device_authorization_endpoint } = await discover()
            const deviceRes = await fetch(device_authorization_endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
              body: new URLSearchParams({
                client_id: CLIENT_ID,
                scope: SCOPE,
              }),
            })
            if (!deviceRes.ok) {
              throw new Error(`xAI device auth failed: HTTP ${deviceRes.status}`)
            }
            const device = (await deviceRes.json()) as {
              device_code: string
              user_code: string
              verification_uri?: string
              verification_uri_complete?: string
              interval?: number
              expires_in?: number
            }
            const verifyUrl =
              device.verification_uri_complete ||
              device.verification_uri ||
              "https://auth.x.ai/device"
            const intervalMs = Math.max((device.interval ?? 5) * 1000, 1000)

            return {
              url: verifyUrl,
              method: "auto" as const,
              instructions: `Open the URL and enter code: ${device.user_code}`,
              callback: async () => {
                const deadline = Date.now() + (device.expires_in ?? 900) * 1000
                while (Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, intervalMs))
                  const tokenRes = await fetch(token_endpoint, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/x-www-form-urlencoded",
                      "User-Agent": UA,
                    },
                    body: new URLSearchParams({
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                      device_code: device.device_code,
                      client_id: CLIENT_ID,
                    }),
                  })
                  const tokens = (await tokenRes.json()) as {
                    access_token?: string
                    refresh_token?: string
                    expires_in?: number
                    error?: string
                  }
                  if (tokens.error === "authorization_pending" || tokens.error === "slow_down") {
                    continue
                  }
                  if (!tokenRes.ok || !tokens.access_token) {
                    return { type: "failed" as const }
                  }
                  return {
                    type: "success" as const,
                    access: tokens.access_token,
                    refresh: tokens.refresh_token ?? "",
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                }
                return { type: "failed" as const }
              },
            }
          },
        },
        {
          label: "Import from Codex (~/.codex/xai_oauth.json)",
          type: "oauth" as const,
          authorize: async () => {
            return {
              url: "",
              method: "auto" as const,
              instructions: "Importing tokens from ~/.codex/xai_oauth.json …",
              callback: async () => {
                const store = await readCodexStore()
                if (!store?.access_token) return { type: "failed" as const }
                const expires =
                  typeof store.expires_at === "number" && store.expires_at > 1e12
                    ? store.expires_at
                    : typeof store.expires_at === "number"
                      ? store.expires_at * 1000
                      : Date.now() + 3600_000
                return {
                  type: "success" as const,
                  access: store.access_token,
                  refresh: store.refresh_token ?? "",
                  expires,
                }
              },
            }
          },
        },
        {
          label: "xAI API key (console.x.ai)",
          type: "api" as const,
          authorize: async () => ({ type: "success" as const, key: "" }),
        },
      ],
    },
  }
}
