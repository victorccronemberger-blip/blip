import { createServer } from "node:http"

export type Pkce = {
  verifier: string
  challenge: string
}

export type OAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const encode = (input: ArrayBuffer) => Buffer.from(input).toString("base64url")

export async function createPkce(): Promise<Pkce> {
  const verifier = encode(crypto.getRandomValues(new Uint8Array(64)).buffer)
  return {
    verifier,
    challenge: encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  }
}

export function createOAuthState() {
  return encode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

export function copyHeaders(input?: HeadersInit) {
  return new Headers(input)
}

const escapeHtml = (input: string) =>
  input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const page = (title: string, message: string, error = false) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}main{max-width:36rem;padding:2rem;text-align:center}h1{color:${error ? "#ff7867" : "#72df9b"}}p{color:#bbb}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`

export async function createLoopbackCallback(input?: { path?: string; timeoutMs?: number }): Promise<{
  redirectUri: string
  wait: Promise<{ code: string; state?: string }>
  close: () => Promise<void>
}> {
  const callbackPath = input?.path ?? "/callback"
  const server = createServer()
  const close = () =>
    new Promise<void>((resolve) => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
    })

  const wait = new Promise<{ code: string; state?: string }>((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        void close()
        reject(new Error("OAuth callback timed out"))
      },
      input?.timeoutMs ?? 10 * 60 * 1000,
    )

    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (url.pathname !== callbackPath) {
        response.writeHead(404).end("Not found")
        return
      }

      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
      const code = url.searchParams.get("code")
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      if (error || !code) {
        const message = error ?? "The authorization server did not return a code."
        response.writeHead(400).end(page("Authorization failed", message, true))
        clearTimeout(timeout)
        void close()
        reject(new Error(message))
        return
      }

      response.writeHead(200).end(page("Authorization complete", "You can close this tab and return to MiMoCode."))
      clearTimeout(timeout)
      void close()
      resolve({ code, state: url.searchParams.get("state") ?? undefined })
    })
  })
  wait.catch(() => {})

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    await close()
    throw new Error("OAuth callback server did not expose a TCP port")
  }

  return {
    redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`,
    wait,
    close,
  }
}
