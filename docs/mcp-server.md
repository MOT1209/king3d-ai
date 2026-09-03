# MCP server

`ai3d-mcp-server` exposes the pipeline as MCP tools, so any MCP-compatible coding
agent - Claude Code, Claude Desktop, Cursor, Windsurf, and others - can drive it
directly instead of shelling out to the CLI.

## Why this reuses, not duplicates, the pipeline

Every tool calls the same functions the CLI and the web dashboard already call -
`apiCreateRun`, `apiSpecAnswer`, `apiRequestReview`, `apiReviewAnswer` from
`src/server/routes.ts`, and `buildFromSpec` from `src/pipeline/run.ts` (via
`src/mcp/build-run.ts`, which mirrors `http.ts`'s SSE build but returns one
result instead of streaming). A run created through an agent's MCP tool calls,
the dashboard, or `ai3d gen` are indistinguishable on disk - same `runs/<id>/`
layout, same `spec.json`, same gate report.

`src/mcp/index.ts` is only the transport and schema layer. It contains no
pipeline logic of its own.

## Running it

```bash
node src/mcp/index.ts
```

It speaks MCP over stdio - the transport nearly every local coding agent
expects, since the client spawns it as a subprocess and talks over
stdin/stdout. Nothing is ever written to stdout except protocol frames;
diagnostics go through the project's logger, which is stderr-only.

### Registering it with a client

Most MCP clients read a JSON config naming the command to spawn. For example,
Claude Code's `.mcp.json` (or the equivalent in Claude Desktop / Cursor /
Windsurf):

```json
{
  "mcpServers": {
    "ai3d": {
      "command": "node",
      "args": ["/absolute/path/to/project image 3d/src/mcp/index.ts"]
    }
  }
}
```

No environment variables are required - see `docs/setup.md` for the same
optional overrides (`AI3D_BLENDER_PATH`, `AI3D_BACKEND`, etc.) the CLI accepts.

## Tools

| Tool | Read-only | Purpose |
|---|---|---|
| `ai3d_doctor` | yes | Environment check: Blender found, daemon running, memory pressure |
| `ai3d_list_runs` | yes | Paginated run list with status and scores |
| `ai3d_get_run` | yes | Full detail: spec, repaired spec, report, any pending judgement request |
| `ai3d_create_run` | no | Start a run from an image path, a prompt, or both |
| `ai3d_submit_spec_answer` | no | Answer a pending spec request; completes and validates the draft |
| `ai3d_build` | no | Run geometry/lighting/render/gates/export for a run's accepted spec |
| `ai3d_request_review` | no | Ask for a judgement on a built run |
| `ai3d_submit_review_answer` | no | Answer a pending review; applies any machine-applicable fixes |

The judgement stages (`ai3d_create_run` and `ai3d_request_review`) work exactly
like the CLI's file-based flow: the tool returns the full question as text (the
same content that would land in `prompts/<stage>.request.md`) and the calling
agent - which is the model - answers it directly as the next tool call. No API
key, no separate provider: the agent using these tools *is* the judgement.

`ai3d_submit_spec_answer` and `ai3d_submit_review_answer` accept the answer
either as a JSON object or as a JSON string (a markdown code fence around it is
tolerated), so an agent can pass whichever is more natural to construct.

### A typical session

```
ai3d_create_run(image_path: "ref.png")
  -> { runId, status: "needs_spec", request: "<the analysis question>" }

# agent reads the reference image, answers:
ai3d_submit_spec_answer(run_id, spec: {...})
  -> { status: "spec_ready", spec }

ai3d_build(run_id)
  -> { passed, scores, gates, artifacts: { contact_sheet, glb, ... } }

# agent looks at artifacts.contact_sheet:
ai3d_request_review(run_id)
  -> { status: "needs_review", request: "<the review question>" }

ai3d_submit_review_answer(run_id, verdict: {...})
  -> { verdict, scores, repair: { applied, skipped } }

# if repair.applied is non-empty:
ai3d_build(run_id, from_repaired: true)
  -> a new run id, built from the corrected spec
```

## Verified

Tested with the MCP TypeScript SDK's own `Client` over a real `StdioClientTransport`
subprocess - not by importing the handlers directly - so the check covers the
actual protocol: `tools/list` returns all eight tools with descriptions,
annotations and schemas, and a full create → spec answer → build → review →
review answer cycle completes with `ai3d_get_run` reflecting each stage
correctly. 16 automated tests in `tests/mcp/server.test.ts` cover tool
discovery, annotation correctness, and both success and error paths (unknown
run, missing image, invalid JSON, oversized pagination limit, review requested
before a build exists).
