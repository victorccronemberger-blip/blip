import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import z from "zod"
import { OAUTH_DUMMY_KEY } from "../auth"
import { copyHeaders, createLoopbackCallback, createOAuthState, createPkce, type OAuthFetch } from "./oauth"

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever",
]
const DEFAULT_AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"

type GoogleClient = {
  clientId: string
  clientSecret: string
  authUri: string
  tokenUri: string
}

const GoogleToken = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

export type GoogleOAuthAuth = {
  type: "oauth"
  access: string
  refresh: string
  expires: number
  metadata?: Record<string, string>
}
const refreshes = new Map<string, Promise<GoogleOAuthAuth>>()

const expandHome = (input: string) =>
  input === "~" ? os.homedir() : input.startsWith(`~${path.sep}`) ? path.join(os.homedir(), input.slice(2)) : input

export async function readGoogleClient(file: string): Promise<GoogleClient> {
  const document = z
    .object({
      installed: z
        .object({
          client_id: z.string().optional(),
          client_secret: z.string().optional(),
          auth_uri: z.string().optional(),
          token_uri: z.string().optional(),
        })
        .optional(),
    })
    .parse(JSON.parse(await fs.readFile(expandHome(file.trim()), "utf8")))
  if (!document.installed?.client_id || !document.installed.client_secret) {
    throw new Error("Expected a Google OAuth client JSON for an application of type Desktop app")
  }
  return {
    clientId: document.installed.client_id,
    clientSecret: document.installed.client_secret,
    authUri: document.installed.auth_uri ?? DEFAULT_AUTH_URI,
    tokenUri: document.installed.token_uri ?? DEFAULT_TOKEN_URI,
  }
}

const adcFiles = () =>
  [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.platform === "win32"
      ? path.join(
          process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
          "gcloud",
          "application_default_credentials.json",
        )
      : path.join(
          process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
          "gcloud",
          "application_default_credentials.json",
        ),
  ].filter((item): item is string => Boolean(item))

export async function readGoogleAdc(file?: string) {
  const selected = file
    ? expandHome(file.trim())
    : (await Promise.all(adcFiles().map(async (item) => [item, await fs.exists(item)] as const))).find(
        ([, exists]) => exists,
      )?.[0]
  if (!selected) throw new Error("Google Application Default Credentials were not found")
  const document = z
    .object({
      type: z.string().optional(),
      client_id: z.string().optional(),
      client_secret: z.string().optional(),
      refresh_token: z.string().optional(),
      quota_project_id: z.string().optional(),
      token_uri: z.string().optional(),
    })
    .parse(JSON.parse(await fs.readFile(selected, "utf8")))
  if (
    document.type !== "authorized_user" ||
    !document.client_id ||
    !document.client_secret ||
    !document.refresh_token
  ) {
    throw new Error("ADC must contain authorized_user OAuth credentials")
  }
  return {
    clientId: document.client_id,
    clientSecret: document.client_secret,
    refreshToken: document.refresh_token,
    projectId: document.quota_project_id,
    tokenUri: document.token_uri ?? DEFAULT_TOKEN_URI,
  }
}

async function requestToken(tokenUri: string, body: URLSearchParams, fetcher: OAuthFetch = fetch) {
  const response = await fetcher(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  const token = GoogleToken.parse(await response.json())
  if (!response.ok || !token.access_token) {
    throw new Error(
      `Google OAuth token request failed: ${token.error_description ?? token.error ?? `HTTP ${response.status}`}`,
    )
  }
  return token
}

const metadata = (client: GoogleClient, projectId: string, source: string) => ({
  clientId: client.clientId,
  clientSecret: client.clientSecret,
  tokenUri: client.tokenUri,
  projectId,
  source,
})

export async function refreshGoogleOAuth(auth: GoogleOAuthAuth, fetcher: OAuthFetch = fetch) {
  if (auth.expires > Date.now() + 120_000) return auth
  if (!auth.refresh) throw new Error("The Google OAuth session expired and has no refresh token")
  if (!auth.metadata?.clientId || !auth.metadata.clientSecret || !auth.metadata.tokenUri) {
    throw new Error("The Google OAuth client metadata is missing; sign in again")
  }
  const pending = refreshes.get(auth.refresh)
  if (pending) return pending
  const task = requestToken(
    auth.metadata.tokenUri,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.refresh,
      client_id: auth.metadata.clientId,
      client_secret: auth.metadata.clientSecret,
    }),
    fetcher,
  ).then((token) => ({
    ...auth,
    access: token.access_token!,
    refresh: token.refresh_token ?? auth.refresh,
    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
  }))
  refreshes.set(auth.refresh, task)
  return task.finally(() => refreshes.delete(auth.refresh))
}

const oauthPrompts = [
  {
    type: "text" as const,
    key: "clientFile",
    message: "Path to the Google Desktop OAuth client JSON",
    placeholder: "~/client_secret.json",
    validate: (value: string) => (value.trim() ? undefined : "The OAuth client JSON path is required"),
  },
  {
    type: "text" as const,
    key: "projectId",
    message: "Google Cloud project ID used for Gemini quota/billing",
    placeholder: "my-google-cloud-project",
    validate: (value: string) => (value.trim() ? undefined : "The Google Cloud project ID is required"),
  },
]

export async function GoogleOAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "google",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type === "api") return { apiKey: auth.key }
        if (auth.type !== "oauth") return {}
        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const current = await getAuth()
            if (current.type !== "oauth") throw new Error("Google OAuth credentials were removed")
            const updated = await refreshGoogleOAuth(current as GoogleOAuthAuth)
            if (updated.access !== current.access || updated.refresh !== current.refresh) {
              await input.client.auth.set({ path: { id: "google" }, body: updated })
            }
            const headers = copyHeaders(requestInput instanceof Request ? requestInput.headers : undefined)
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
            headers.delete("authorization")
            headers.delete("x-goog-api-key")
            headers.set("authorization", `Bearer ${updated.access}`)
            if (updated.metadata?.projectId) headers.set("x-goog-user-project", updated.metadata.projectId)

            const url = new URL(requestInput instanceof Request ? requestInput.url : requestInput.toString())
            url.searchParams.delete("key")
            const request = requestInput instanceof Request ? new Request(url, requestInput) : url
            return fetch(request, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "Gemini OAuth (Google Cloud Desktop app)",
          type: "oauth",
          prompts: oauthPrompts,
          authorize: async (inputs) => {
            const client = await readGoogleClient(inputs?.clientFile ?? "")
            const projectId = inputs?.projectId?.trim()
            if (!projectId) throw new Error("The Google Cloud project ID is required")
            const pkce = await createPkce()
            const state = createOAuthState()
            const callback = await createLoopbackCallback()
            const url = new URL(client.authUri)
            url.search = new URLSearchParams({
              client_id: client.clientId,
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
              instructions: "Authorize MiMoCode with the Google account configured as an OAuth test user.",
              callback: async () => {
                try {
                  const result = await callback.wait
                  if (result.state !== state) throw new Error("Google OAuth state mismatch")
                  const token = await requestToken(
                    client.tokenUri,
                    new URLSearchParams({
                      grant_type: "authorization_code",
                      code: result.code,
                      redirect_uri: callback.redirectUri,
                      client_id: client.clientId,
                      client_secret: client.clientSecret,
                      code_verifier: pkce.verifier,
                    }),
                  )
                  return {
                    type: "success" as const,
                    access: token.access_token!,
                    refresh: token.refresh_token ?? "",
                    expires: Date.now() + (token.expires_in ?? 3600) * 1000,
                    metadata: metadata(client, projectId, "desktop-oauth"),
                  }
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
          label: "Import Google Application Default Credentials",
          type: "oauth",
          prompts: [
            {
              type: "text",
              key: "projectId",
              message: "Google Cloud project ID (leave empty to use quota_project_id from ADC)",
              placeholder: "my-google-cloud-project",
            },
          ],
          authorize: async (inputs) => ({
            url: "",
            method: "auto" as const,
            instructions: "Importing Google Application Default Credentials.",
            callback: async () => {
              try {
                const adc = await readGoogleAdc()
                const projectId = inputs?.projectId?.trim() || adc.projectId
                if (!projectId) throw new Error("ADC has no quota_project_id; enter a Google Cloud project ID")
                const client = {
                  clientId: adc.clientId,
                  clientSecret: adc.clientSecret,
                  authUri: DEFAULT_AUTH_URI,
                  tokenUri: adc.tokenUri,
                }
                const token = await requestToken(
                  client.tokenUri,
                  new URLSearchParams({
                    grant_type: "refresh_token",
                    refresh_token: adc.refreshToken,
                    client_id: client.clientId,
                    client_secret: client.clientSecret,
                  }),
                )
                return {
                  type: "success" as const,
                  access: token.access_token!,
                  refresh: adc.refreshToken,
                  expires: Date.now() + (token.expires_in ?? 3600) * 1000,
                  metadata: metadata(client, projectId, "adc"),
                }
              } catch {
                return { type: "failed" as const }
              }
            },
          }),
        },
        {
          label: "Gemini API key (Google AI Studio)",
          type: "api",
          authorize: async () => ({ type: "success" as const, key: "" }),
        },
      ],
    },
  }
}
