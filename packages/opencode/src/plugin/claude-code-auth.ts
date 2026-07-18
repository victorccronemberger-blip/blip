/**
 * Claude / Anthropic auth for MiMoCode.
 *
 * Methods:
 *  1) Import Claude Code OAuth session from ~/.claude/.credentials.json
 *  2) Paste ANTHROPIC_API_KEY (console.anthropic.com)
 *
 * Claude Code Max/Pro OAuth tokens are subscription credentials. They work
 * for many third-party tools via Bearer + anthropic-beta headers; if Anthropic
 * rejects them, use a real console API key instead.
 */
import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../auth"
import os from "os"
import path from "path"
import fs from "fs/promises"

const CLAUDE_CREDS = () => path.join(os.homedir(), ".claude", ".credentials.json")

type ClaudeOauth = {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  refreshTokenExpiresAt?: number
  scopes?: string[]
  subscriptionType?: string
}

async function readClaudeCreds(): Promise<ClaudeOauth | null> {
  try {
    const raw = await fs.readFile(CLAUDE_CREDS(), "utf8")
    const doc = JSON.parse(raw) as { claudeAiOauth?: ClaudeOauth }
    return doc.claudeAiOauth ?? null
  } catch {
    return null
  }
}

function isExpired(expiresAt?: number): boolean {
  if (!expiresAt) return false
  // Claude Code stores ms epoch
  const ms = expiresAt > 1e12 ? expiresAt : expiresAt * 1000
  return Date.now() > ms - 60_000
}

export async function ClaudeCodeAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider.anthropic ??= {
        name: "Anthropic (Claude)",
        npm: "@ai-sdk/anthropic",
        models: {
          "claude-sonnet-4-5": { name: "Claude Sonnet 4.5" },
          "claude-opus-4-5": { name: "Claude Opus 4.5" },
          "claude-haiku-4-5": { name: "Claude Haiku 4.5" },
          "claude-sonnet-4-0": { name: "Claude Sonnet 4" },
          "claude-opus-4-0": { name: "Claude Opus 4" },
        },
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth) {
        const auth = (await getAuth()) as {
          type: string
          key?: string
          access?: string
          refresh?: string
          expires?: number
          metadata?: Record<string, string>
        }
        if (!auth) return {}

        // Console API key path
        if (auth.type === "api" && auth.key) {
          return {
            apiKey: auth.key,
            headers: {
              "anthropic-beta":
                "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
            },
          }
        }

        // Claude Code OAuth path
        if (auth.type === "oauth" && auth.access) {
          const token = auth.access
          return {
            apiKey: OAUTH_DUMMY_KEY,
            headers: {
              "anthropic-beta":
                "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
            },
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
              // Anthropic OAuth: Bearer access token, no x-api-key.
              headers.delete("x-api-key")
              headers.delete("authorization")
              headers.set("authorization", `Bearer ${token}`)
              if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
              return fetch(requestInput, { ...init, headers })
            },
          }
        }

        return {}
      },
      methods: [
        {
          label: "Import Claude Code login (~/.claude/.credentials.json)",
          type: "oauth" as const,
          authorize: async () => ({
            url: "",
            method: "auto" as const,
            instructions: "Reading Claude Code credentials…",
            callback: async () => {
              const oauth = await readClaudeCreds()
              if (!oauth?.accessToken) {
                return { type: "failed" as const }
              }
              if (isExpired(oauth.expiresAt)) {
                // Still import — user may refresh via `claude` CLI; token might still work briefly.
              }
              const expires =
                typeof oauth.expiresAt === "number"
                  ? oauth.expiresAt > 1e12
                    ? oauth.expiresAt
                    : oauth.expiresAt * 1000
                  : Date.now() + 3600_000
              return {
                type: "success" as const,
                access: oauth.accessToken,
                refresh: oauth.refreshToken ?? "",
                expires,
                metadata: {
                  source: "claude-code",
                  subscriptionType: oauth.subscriptionType ?? "",
                },
              }
            },
          }),
        },
        {
          label: "Anthropic API key (console.anthropic.com)",
          type: "api" as const,
          // CLI prompts for password and uses result.key ?? typed key.
          authorize: async () => ({ type: "success" as const, key: "" }),
        },
      ],
    },
  }
}
