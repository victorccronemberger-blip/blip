# Intigriti and HackerOne MCPs

## Goal

Ship native, read-only MCP servers for Intigriti and HackerOne inside the PentesterCode bundle. Both servers must use the researcher's own credentials, stay locked to the official API origin and expose authoritative program scope without adding report-submission or other state-changing actions.

## Contract

- Intigriti: Bearer authentication against `https://api.intigriti.com/external/researcher`, using `INTIGRITI_TOKEN`.
- HackerOne: Basic authentication against `https://api.hackerone.com`, using `HACKERONE_API_USERNAME` and `HACKERONE_API_TOKEN`.
- Accept relative API paths only. Reject absolute URLs, protocol-relative URLs, backslashes and paths outside the documented researcher API prefixes.
- Missing credentials return a clear tool error without crashing MCP startup.
- No credential value is written into config, logs, fixtures, distributions or documentation.

## Work

1. Add tests for authentication headers, allowed paths, external-URL rejection, program lookup and seed inclusion.
2. Add a shared read-only HTTP client and MCP server adapter under `vendor/pentesterflow/src/platform`.
3. Add Intigriti tools for listing programs, resolving a program by GUID or handle, listing program activity and authenticated raw GET.
4. Add HackerOne tools for listing programs, collecting program details/scopes/exclusions and authenticated raw GET.
5. Add thin stdio launchers at `vendor/pentesterflow/intigriti-mcp.ts` and `vendor/pentesterflow/hackerone-mcp.ts`.
6. Enable both servers in portable defaults and document user-side environment setup.
7. Run focused tests first, then package typecheck, seed tests, build/package checks and secret scans.

## Acceptance

- MCP startup succeeds even when credentials are absent.
- Calls without credentials fail explicitly and do not initiate network requests.
- Intigriti sends `Authorization: Bearer ...` only to the official researcher API path.
- HackerOne sends the documented Basic credential only to `/v1/hackers/...`.
- Program scope tools return official structured scope/rules data.
- Seeded Linux/Windows homes contain both MCP launchers and portable config entries.
- Repository and release artifacts contain no real tokens or personal OAuth/API data.
