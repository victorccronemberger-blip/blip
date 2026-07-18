import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readClaudeCredentials, refreshClaudeOAuth } from "@/plugin/claude-code-auth"
import { readGoogleAdc, readGoogleClient, refreshGoogleOAuth } from "@/plugin/google-oauth"
import { createLoopbackCallback, createOAuthState, createPkce, type OAuthFetch } from "@/plugin/oauth"
import { readGrokCredentials, refreshXaiOAuth } from "@/plugin/xai-oauth"

const directories: string[] = []

async function tempFile(name: string, value: unknown) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-oauth-"))
  directories.push(directory)
  const file = path.join(directory, name)
  await fs.writeFile(file, JSON.stringify(value))
  return file
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe("OAuth utilities", () => {
  test("creates RFC 7636 PKCE values and random state", async () => {
    const pkce = await createPkce()
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(createOAuthState()).not.toBe(createOAuthState())
  })

  test("accepts a loopback callback", async () => {
    const callback = await createLoopbackCallback({ timeoutMs: 5_000 })
    const url = new URL(callback.redirectUri)
    url.searchParams.set("code", "authorization-code")
    url.searchParams.set("state", "csrf-state")
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(await callback.wait).toEqual({ code: "authorization-code", state: "csrf-state" })
  })
})

describe("provider credential imports", () => {
  test("reads the official Grok CLI credential format", async () => {
    const file = await tempFile("auth.json", {
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: "grok-access",
        refresh_token: "grok-refresh",
        expires_at: "2030-01-01T00:00:00.000Z",
        oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      },
    })
    expect(await readGrokCredentials(file)).toEqual({
      access: "grok-access",
      refresh: "grok-refresh",
      expires: Date.parse("2030-01-01T00:00:00.000Z"),
    })
  })

  test("reads a Google Desktop OAuth client", async () => {
    const file = await tempFile("client_secret.json", {
      installed: {
        client_id: "google-client",
        client_secret: "google-secret",
        auth_uri: "https://accounts.example/authorize",
        token_uri: "https://accounts.example/token",
      },
    })
    expect(await readGoogleClient(file)).toEqual({
      clientId: "google-client",
      clientSecret: "google-secret",
      authUri: "https://accounts.example/authorize",
      tokenUri: "https://accounts.example/token",
    })
  })

  test("reads authorized_user Google ADC", async () => {
    const file = await tempFile("application_default_credentials.json", {
      type: "authorized_user",
      client_id: "adc-client",
      client_secret: "adc-secret",
      refresh_token: "adc-refresh",
      quota_project_id: "quota-project",
    })
    expect(await readGoogleAdc(file)).toEqual({
      clientId: "adc-client",
      clientSecret: "adc-secret",
      refreshToken: "adc-refresh",
      projectId: "quota-project",
      tokenUri: "https://oauth2.googleapis.com/token",
    })
  })

  test("reads the official Claude Code credential format", async () => {
    const file = await tempFile(".credentials.json", {
      claudeAiOauth: {
        accessToken: "claude-access",
        refreshToken: "claude-refresh",
        expiresAt: 1_900_000_000_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    })
    expect(await readClaudeCredentials(file)).toEqual({
      accessToken: "claude-access",
      refreshToken: "claude-refresh",
      expiresAt: 1_900_000_000_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
    })
  })
})

describe("provider token refresh", () => {
  test("refreshes Grok through the discovered xAI token endpoint", async () => {
    const requests: string[] = []
    const fetcher: OAuthFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push(url)
      if (url.includes("well-known")) {
        return Response.json({
          authorization_endpoint: "https://auth.x.ai/authorize",
          token_endpoint: "https://auth.x.ai/token",
        })
      }
      expect(init?.body).toBeInstanceOf(URLSearchParams)
      expect(init?.body instanceof URLSearchParams ? init.body.get("refresh_token") : undefined).toBe("grok-refresh")
      return Response.json({ access_token: "new-grok-access", refresh_token: "new-grok-refresh", expires_in: 3600 })
    }
    const refreshed = await refreshXaiOAuth(
      { type: "oauth", access: "old", refresh: "grok-refresh", expires: 0 },
      fetcher,
    )
    expect(requests).toEqual(["https://auth.x.ai/.well-known/openid-configuration", "https://auth.x.ai/token"])
    expect(refreshed.access).toBe("new-grok-access")
    expect(refreshed.refresh).toBe("new-grok-refresh")
  })

  test("refreshes Gemini with its persisted Desktop OAuth client", async () => {
    const fetcher: OAuthFetch = async (_input, init) => {
      expect(init?.body).toBeInstanceOf(URLSearchParams)
      const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams()
      expect(body.get("client_id")).toBe("desktop-client")
      expect(body.get("refresh_token")).toBe("google-refresh")
      return Response.json({ access_token: "new-google-access", expires_in: 3600 })
    }
    const refreshed = await refreshGoogleOAuth(
      {
        type: "oauth",
        access: "old",
        refresh: "google-refresh",
        expires: 0,
        metadata: {
          clientId: "desktop-client",
          clientSecret: "desktop-secret",
          tokenUri: "https://oauth2.googleapis.com/token",
          projectId: "quota-project",
        },
      },
      fetcher,
    )
    expect(refreshed.access).toBe("new-google-access")
    expect(refreshed.refresh).toBe("google-refresh")
  })

  test("refreshes Claude and preserves a rotated refresh token", async () => {
    const fetcher: OAuthFetch = async (_input, init) => {
      expect(init?.body).toBeString()
      expect(init?.body).toContain('"grant_type":"refresh_token"')
      expect(init?.body).toContain('"scope":"user:inference"')
      return Response.json({
        access_token: "new-claude-access",
        refresh_token: "new-claude-refresh",
        expires_in: 3600,
        scope: "user:inference",
      })
    }
    const refreshed = await refreshClaudeOAuth(
      {
        type: "oauth",
        access: "old",
        refresh: "claude-refresh",
        expires: 0,
        metadata: { scopes: "user:inference" },
      },
      fetcher,
    )
    expect(refreshed.access).toBe("new-claude-access")
    expect(refreshed.refresh).toBe("new-claude-refresh")
  })
})
