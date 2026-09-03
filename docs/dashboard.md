# Dashboard

`king3d web` starts a browser control panel over the same pipeline the CLI
drives - create a run, paste the spec/review judgements, watch the build
stream live, inspect the report, turn the model over, repair and rebuild.

```bash
node src/cli/index.ts web --port 5180
```

## Why a second front end reuses, not duplicates, the pipeline

`src/server/routes.ts` calls the exact library functions the CLI calls -
`buildSpecRequest`, `buildReviewRequest`, `AgentInLoopProvider.ask`,
`applyRepairs`, `withSimilarity`, `completeDraft`, `buildFromSpec` - so a run
built from the dashboard and a run built from `king3d gen` are indistinguishable
on disk. `gen.ts`, `review.ts` and `build.ts` are untouched; the dashboard is a
second, JSON-shaped way to drive the same pipeline, not a reimplementation of
it.

## Shape

```
src/server/
  runs-list.ts   run discovery: status is derived from which files exist
                 (spec.json, report.json, pending request/response pairs),
                 never tracked separately - so it can't drift from what
                 actually happened to a run
  routes.ts      pure handlers: (input) -> {status, body}, no node:http
                 objects, testable directly with vitest
  http.ts        the node:http adapter: JSON dispatch, SSE for build/rebuild,
                 static assets, and each run's own files behind a
                 traversal-safe prefix check
src/cli/web.ts   `king3d web [--port]`
web/             index.html + app.js + style.css, no build step, same
                 vanilla-three.js approach as viewer/index.html
```

## The judgement stages stay manual - on purpose

The spec and review stages still work the way the CLI's file-based flow does:
the dashboard shows the rendered request (the same text that would land in
`prompts/<stage>.request.md`) and a textarea to paste a JSON answer into. No
API key, no new provider - the agent reading the dashboard is the model, same
as reading a file. `AnswerInput.text` goes straight to the provider's response
path exactly as if it had been written by hand.

## Endpoints

```
GET  /api/runs                     list, with derived status per run
POST /api/runs                     {prompt?, hints?, imageBase64?, imageName?}
                                    -> 202 {runId, status, request}
GET  /api/runs/:id                 summary, spec, repaired spec, report,
                                    any pending request text
POST /api/runs/:id/spec-answer     {text} -> validates, completes the draft,
                                    writes spec.json
POST /api/runs/:id/review          asks for a review -> 202 with request text,
                                    or 200 once one already exists
POST /api/runs/:id/review-answer   {text} -> merges the similarity score,
                                    applies fixes, writes spec.repaired.json
POST /api/runs/:id/build           text/event-stream: `stage` events per
                                    pipeline stage, then `done` or `error`
POST /api/runs/:id/rebuild         same, from spec.repaired.json
GET  /api/runs/:id/files/*         the run's own artefacts only
```

Build and rebuild are POST + SSE, so the frontend cannot use `EventSource`
(GET-only) - `web/app.js`'s `streamBuild()` parses `event: .. \ndata: ..\n\n`
frames out of a plain `fetch()` body reader instead.

**Concurrency.** One Blender daemon serves every request, so `http.ts` queues
builds behind a promise chain - the same reason `SocketBackend` queues
individual commands one level down
(`src/integrations/blender/socket.ts`). Two browser tabs building at once
queue rather than collide.

**Image upload.** Reference images travel as base64 inside a JSON body rather
than multipart form data - these are small preview-sized images, and it avoids
hand-rolling a multipart parser over plain `node:http` for one field.

## A bug this surfaced

Building this exposed a real collision: `newRunId()` had only second-level
timestamp resolution, so two runs created within the same second - two quick
CLI invocations, or two dashboard uploads - silently overwrote each other's
directory. Fixed by appending a short random suffix
(`src/pipeline/run.ts:newRunId`); this benefits the CLI too, not just the
dashboard.

## Verified

Driven end to end over raw HTTP (not just through the browser): image upload
→ spec request → spec answer → build via SSE (11/11 gates, 0.992) → GLB and
contact sheet download → review request → review answer → merged score
(0.974) → run status `reviewed`. Path traversal against `/files/*` was tried
with `../`, percent-encoded (`%2e%2e`), and double-encoded forms - all
blocked. 81 automated tests pass (67 pre-existing + 14 new route tests).
