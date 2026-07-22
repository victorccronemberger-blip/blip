---
name: multi-llm
description: "Use this skill whenever you might want input from a DIFFERENT LLM than the one currently running — a second opinion, a specialist model, or a delegated full agent on another model. Trigger on: 'ask another model', 'get a second opinion', 'consult GPT/Gemini/Claude/another LLM', 'what would <model> say', 'cross-check with another model', 'delegate this to a different model', 'have <model> review this', hard or risky decisions where an independent model could catch an error, or domain-specialist questions better suited to a model with different strengths. Explains the native `consult` tool (one-shot Q&A with another configured model) and how it differs from spawning a subagent on another model via `actor`."
version: 1.0.0
license: MIT
platforms: [linux, macos, windows]
---

# Multi-LLM Orchestration

Two distinct native ways to bring another model into play. Pick based on whether you need a single answer or a full working agent.

## `consult` — one-shot second opinion from another model

Sends ONE question to ONE other configured model and returns its answer. No tools, no session, no memory, no follow-up turns — and the consulted model does **not** see this conversation, so the prompt must be fully self-contained.

Workflow:
1. Call `consult` with `{"operation":{"action":"list_models"}}` to discover which models are available. Always do this first if you're not sure — don't guess a model name.
2. Call `consult` with `{"operation":{"action":"ask","model":"<from the list>","prompt":"<self-contained question>","system":"<optional>","temperature":<optional>}}`.

Example:
```
{"operation":{"action":"ask","model":"openai/gpt-5.1","prompt":"Given this stack trace, what's the most likely root cause?\n<trace>...</trace>"}}
```

Who controls which models (no config editing needed): by default (permission mode) ANY configured model can be consulted, but the first time you use one the user gets a TUI approval prompt — once / always / deny. "Always" remembers it. So the user builds their allowlist right from the chat; you never tell them to edit a file. (Advanced: a user CAN pin a fixed `consult.models` allowlist in `mimocode.json`, in which case only those are callable — `list_models` still shows you the truth either way.) A model that isn't configured at all, or that the user denies, fails with a clear error and never silently falls back to another model.

## `actor` — a full subagent on a different model

When you need more than one answer — a subagent with its own tool access, its own multi-turn loop, doing real work (reading files, running commands, writing code) — spawn it on a specific model with the `model` field/flag on `actor run` or `actor spawn`:
```
{"operation":{"action":"run","subagent_type":"explore","description":"...","prompt":"...","model":"anthropic/claude-opus-4-5"}}
```
or in shell form: `actor run <subagent_type> "<description>" "<prompt>" --model <provider/model>`.

This is NOT gated by the `consult.models` allowlist — it uses the model configuration `actor`/agents already have access to (run `actor models` to see what's available).

## consult vs. actor — which one

| | `consult` | `actor` |
|---|---|---|
| Scope | one question, one answer | full agentic loop |
| Tools | none | whatever the subagent's agent type grants |
| Sees this conversation | no — self-contained prompt only | only if `context="full"` |
| Gated by | TUI approval (or `consult.models`) | agent/model config |
| Use for | second opinion, quick cross-check, specialist sub-question | delegated multi-step work, parallel investigation, isolated heavy lifting |

Don't reach for `actor` when a single question will do — that's tool-budget overhead the user didn't ask for. Don't reach for `consult` when the task needs file reads, command execution, or iteration — it has no tool access at all.

## When to reach for another model

- A hard or risky decision where an independently-trained model might catch an error you'd miss.
- A domain-specialist model (e.g. a reasoning-heavy model for a tricky proof, a cheap/fast model for a bulk sub-task).
- Cross-checking a conclusion before committing to something irreversible.
- The user explicitly asks what another model thinks, or asks you to delegate to one.

Don't guess a model name — call `list_models` and pick from what it returns. If the user approves a model "always" when prompted, it's remembered for next time.

## Keeping the model list clean — `/remove`

Over time the model list grows as providers get connected and forgotten. Two ways to prune it:

- **`/remove`** (native TUI picker, just like `/connect`): the user runs the slash command and a modal lists their connected providers; they pick one, confirm, and its saved credentials are deleted. This is entirely in the UI — you are not involved. Point the user here when they ask how to clean up the list.
- **Ask you in chat** ("remove the providers I don't use"): you can do it with the `providers` tool —
  1. `{"operation":{"action":"list_connected"}}` — saved providers, auth type, model counts.
  2. Let the user pick (e.g. the `question` tool, multi-select).
  3. `{"operation":{"action":"remove","providers":["<ids the user chose>"]}}` — deletes those saved credentials (destructive; the user confirms).

Either way, models refresh on the next launch, and you only ever remove providers the user explicitly selected.
