import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { OAUTH_DUMMY_KEY } from "../auth"
import { copyHeaders, createOAuthState, createPkce, type OAuthFetch } from "./oauth"

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
const SCOPES = ["user:inference"]
const BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14"

const ClaudeCredentials = z.object({
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()).optional(),
  subscriptionType: z.string().optional(),
})

const ClaudeToken = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

export type ClaudeOAuthAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, string>
}
const refreshes = new Map<string, Promise<ClaudeOAuthAuth>>()

const credentialsFile = () => path.join(os.homedir(), ".claude", ".credentials.json")

export async function readClaudeCredentials(file = credentialsFile()) {
  const document = z
    .object({ claudeAiOauth: ClaudeCredentials.optional() })
    .parse(JSON.parse(await fs.readFile(file, "utf8")))
  if (!document.claudeAiOauth?.accessToken) return undefined
  return document.claudeAiOauth
}

const normalizeExpiry = (value?: number) => {
  if (!value) return Date.now() + 60 * 60 * 1000
  return value > 1e12 ? value : value * 1000
}

async function tokenRequest(body: Record<string, string>, fetcher: OAuthFetch = fetch) {
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const token = ClaudeToken.parse(await response.json())
  if (!response.ok || !token.access_token) {
    throw new Error(
      `Claude OAuth token request failed: ${token.error_description ?? token.error ?? `HTTP ${response.status}`}`,
    )
  }
  return token
}

export async function refreshClaudeOAuth(auth: ClaudeOAuthAuth, fetcher: OAuthFetch = fetch) {
  if (auth.expires > Date.now() + 120_000) return auth
  if (!auth.refresh) throw new Error("The Claude OAuth session expired and has no refresh token")
  const pending = refreshes.get(auth.refresh)
  if (pending) return pending
  const task = tokenRequest(
    {
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: CLIENT_ID,
      scope: auth.metadata?.scopes ?? SCOPES.join(" "),
    },
    fetcher,
  ).then((token) => ({
    ...auth,
    access: token.access_token!,
    refresh: token.refresh_token ?? auth.refresh,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
    metadata: {
      ...auth.metadata,
      scopes: token.scope ?? auth.metadata?.scopes ?? SCOPES.join(" "),
    },
  }))
  refreshes.set(auth.refresh, task)
  return task.finally(() => refreshes.delete(auth.refresh))
}

const parseCode = (input: string, expectedState: string) => {
  const value = input.trim()
  if (URL.canParse(value)) {
    const url = new URL(value)
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (!code) throw new Error("The Claude callback URL has no authorization code")
    if (state && state !== expectedState) throw new Error("Claude OAuth state mismatch")
    return code
  }
  const [code, state] = value.split("#", 2)
  if (!code) throw new Error("The Claude authorization code is empty")
  if (state && state !== expectedState) throw new Error("Claude OAuth state mismatch")
  return code
}

export async function ClaudeCodeAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider.anthropic ??= {
        name: "Anthropic (Claude)",
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-opus-4-6": { name: "Claude Opus 4.6" },
          "claude-sonnet-4-6": { name: "Claude Sonnet 4.6" },
          "claude-haiku-4-5": { name: "Claude Haiku 4.5" },
        },
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (auth.type === "api") {
          return {
            apiKey: auth.key,
            headers: { "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14" },
          }
        }
        if (auth.type !== "oauth") return {}

        for (const model of Object.values(provider.models)) {
          model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
        }
        return {
          apiKey: OAUTH_DUMMY_KEY,
          headers: { "anthropic-beta": BETA },
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const current = await getAuth()
            if (current.type !== "oauth") throw new Error("Claude OAuth credentials were removed")
            const updated = await refreshClaudeOAuth(current as ClaudeOAuthAuth)
            if (updated.access !== current.access || updated.refresh !== current.refresh) {
              await input.client.auth.set({ path: { id: "anthropic" }, body: updated })
            }
            const headers = copyHeaders(requestInput instanceof Request ? requestInput.headers : undefined)
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
            headers.delete("x-api-key")
            headers.delete("authorization")
            headers.set("authorization", `Bearer ${updated.access}`)
            headers.set("anthropic-beta", BETA)
            if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max OAuth (browser)",
          type: "oauth",
          authorize: async () => {
            const pkce = await createPkce()
            const state = createOAuthState()
            const url = new URL(AUTHORIZE_URL)
            url.search = new URLSearchParams({
              code: "true",
              client_id: CLIENT_ID,
              response_type: "code",
              redirect_uri: REDIRECT_URI,
              scope: SCOPES.join(" "),
              code_challenge: pkce.challenge,
              code_challenge_method: "S256",
              state,
            }).toString()
            return {
              url: url.toString(),
              method: "code" as const,
              instructions:
                "Complete the Claude authorization, then paste the code shown by the official callback page.",
              callback: async (input: string) => {
                try {
                  const token = await tokenRequest({
                    grant_type: "authorization_code",
                    code: parseCode(input, state),
                    redirect_uri: REDIRECT_URI,
                    client_id: CLIENT_ID,
                    code_verifier: pkce.verifier,
                    state,
                  })
                  return {
                    type: "success" as const,
                    access: token.access_token!,
                    refresh: token.refresh_token ?? "",
                    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
                    metadata: {
                      source: "claude-code-oauth",
                      scopes: token.scope ?? SCOPES.join(" "),
                    },
                  }
                } catch {
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
        {
          label: "Import official Claude Code login (~/.claude/.credentials.json)",
          type: "oauth",
          authorize: async () => ({
            url: "",
            method: "auto" as const,
            instructions: "Importing the official Claude Code OAuth session.",
            callback: async () => {
              try {
                const credential = await readClaudeCredentials()
                if (!credential?.accessToken) return { type: "failed" as const }
                return {
                  type: "success" as const,
                  access: credential.accessToken,
                  refresh: credential.refreshToken ?? "",
                  expires: normalizeExpiry(credential.expiresAt),
                  metadata: {
                    source: "claude-code",
                    scopes: credential.scopes?.join(" ") ?? SCOPES.join(" "),
                    subscriptionType: credential.subscriptionType ?? "",
                  },
                }
              } catch {
                return { type: "failed" as const }
              }
            },
          }),
        },
        {
          label: "Anthropic API key (console.anthropic.com)",
          type: "api",
          authorize: async () => ({ type: "success" as const, key: "" }),
        },
      ],
    },
  }
}
