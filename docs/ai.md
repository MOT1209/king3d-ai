# In-app AI

The editor can ask a language model to propose edits ("make the handle 20% wider and
the mug matte black"). It is **optional**: with nothing configured, King3D still
needs no key at all — the agent driving the session (Claude Code, Codex, …) is the
model, as before.

## What the model can and cannot do
- It proposes `{ path, value }` fixes on the SceneSpec — the same vocabulary as the
  inspector (sizes, placements, rotations, material colour / metallic / roughness).
- It **cannot** add or remove parts or change how anything is built. Paths outside
  that vocabulary are rejected, the model is told and retried once, then the request
  fails with HTTP 502.
- Fixes that name a part or material that does not exist are dropped and reported.
- Nothing is written. A proposal comes back to the editor; **Add to pending** puts the
  values in the inspector, where you can still change them before **Apply & rebuild**.

## Configure
Set environment variables (copy `.env.example` to `.env`, which is git-ignored) and
start the dashboard with `node --env-file=.env src/cli/index.ts web`.

| Variable | Meaning |
|---|---|
| `KING3D_LLM_PROVIDER` | `agent` (default, no in-app model), `anthropic`, or `openai-compatible` |
| `KING3D_LLM_MODEL` | Model id. Defaults to `claude-opus-5-5` for `anthropic`; required otherwise |
| `KING3D_LLM_BASE_URL` | Required for `openai-compatible`; optional override for `anthropic` |
| `KING3D_LLM_API_KEY` | Secret. Optional for local servers; for `anthropic` it may also come from `ANTHROPIC_API_KEY` or an `ant auth login` profile |

### Anthropic (Claude)
```bash
KING3D_LLM_PROVIDER=anthropic
KING3D_LLM_API_KEY=sk-ant-...
```
Uses the official `@anthropic-ai/sdk` (an optional dependency, loaded only when this
provider is selected). On the models that support it, server-side refusal fallbacks
are enabled by default (`fallbacks: "default"`); a refusal that still gets through
is reported as an error, never read as an empty answer.

### OpenAI-compatible
One adapter covers every server that speaks the OpenAI chat-completions protocol:

| Service | `KING3D_LLM_BASE_URL` | Key |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | yes |
| OpenRouter (one key, many models) | `https://openrouter.ai/api/v1` | yes |
| Ollama (local, free) | `http://127.0.0.1:11434/v1` | no |
| LM Studio (local, free) | `http://127.0.0.1:1234/v1` | no |
| Gemini compatibility endpoint | `https://generativelanguage.googleapis.com/v1beta/openai/` | yes — verify the URL against Google's current docs |

## Subscriptions are not API keys
A ChatGPT Plus or Claude Pro subscription **cannot** be used as an API key here; the
vendors bill API access separately. The legitimate way to use a subscription is the
existing path: let an agent that has it (Claude Code, Codex, …) drive King3D over MCP.

## Security
- The key is read from the environment and never logged, never returned by any
  route (`GET /api/llm` reports provider and model only), and never sent to a phone.
- Error messages are built without request headers, so a failing call cannot echo the key.
- The dashboard binds to `127.0.0.1`. Do not expose it to a network while a key is configured.

## Status
Implemented: the provider layer, the editor's AI chat, `GET /api/llm`,
`POST /api/runs/:id/ai-edit`. Not yet: answering the spec and review stages with the
same model (they still use the agent-in-the-loop flow), and an in-app settings screen.
