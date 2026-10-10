import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paths } from "../../src/core/config.ts";
import { runPaths } from "../../src/pipeline/run.ts";

/**
 * Drives the MCP server as a real subprocess over stdio - the same transport a
 * coding agent uses - rather than importing its handlers directly. A server
 * that type-checks can still speak the wrong protocol; this is what proves it
 * actually answers `tools/list` and `tools/call` correctly.
 */
let client: Client;
const createdRunIds: string[] = [];

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(paths.root, "src", "mcp", "index.ts")],
    cwd: paths.root,
  });
  client = new Client({ name: "vitest-mcp-client", version: "0.0.1" });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await Promise.all(createdRunIds.map((id) => rm(runPaths(id).dir, { recursive: true, force: true })));
});

/**
 * Call a tool. `timeoutMs` overrides the MCP client's 60s default, which a
 * cold Blender start (30-90s on modest hardware) can exceed - king3d_doctor
 * performs that check when no daemon is running, so it needs the headroom.
 */
async function call(name: string, args: Record<string, unknown> = {}, timeoutMs?: number) {
  const res = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined);
  const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  let json: unknown = undefined;
  try {
    json = JSON.parse(text.replace(/^Error \(HTTP \d+\): /, ""));
  } catch {
    /* not JSON, that's fine for some error paths */
  }
  return { isError: res.isError === true, text, json };
}

describe("tool discovery", () => {
  it("lists all nine tools with complete metadata", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "king3d_build",
        "king3d_create_run",
        "king3d_doctor",
        "king3d_generate",
        "king3d_get_run",
        "king3d_list_runs",
        "king3d_request_review",
        "king3d_submit_review_answer",
        "king3d_submit_spec_answer",
      ].sort(),
    );

    for (const tool of tools) {
      expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(20);
      expect(tool.annotations, `${tool.name} annotations`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeTruthy();
    }
  });

  it("marks every tool as local-only, matching a Blender pipeline with no external API calls", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it("marks read-only tools correctly", async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName["king3d_doctor"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["king3d_list_runs"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["king3d_get_run"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["king3d_create_run"]?.annotations?.readOnlyHint).toBe(false);
    expect(byName["king3d_build"]?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("king3d_doctor", () => {
  it("runs environment checks and returns structured content", async () => {
    // The doctor cold-starts Blender when the daemon is down (up to 300s by
    // default), which blows past the MCP client's 60s default request timeout.
    const result = await call("king3d_doctor", {}, 330_000);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("king3d doctor");
  });
});

describe("king3d_list_runs", () => {
  it("returns a paginated shape", async () => {
    const result = await call("king3d_list_runs", { limit: 2 });
    expect(result.isError).toBe(false);
    const body = result.json as { total: number; count: number; runs: unknown[] };
    expect(body.count).toBeLessThanOrEqual(2);
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it("rejects a limit above the schema maximum rather than silently clamping", async () => {
    const result = await call("king3d_list_runs", { limit: 99999 });
    expect(result.isError).toBe(true);
  });
});

describe("king3d_get_run", () => {
  it("returns a not-found error for an unknown run", async () => {
    const result = await call("king3d_get_run", { run_id: "no_such_run_xyz" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("RUN_NOT_FOUND");
  });
});

describe("king3d_create_run", () => {
  it("rejects a run with neither an image nor a prompt", async () => {
    const result = await call("king3d_create_run", {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/image_path or prompt/);
  });

  it("errors clearly when image_path does not exist", async () => {
    const result = await call("king3d_create_run", { image_path: "no/such/file.png" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/could not read image/);
  });

  it("creates a run from a prompt and returns the pending spec request", async () => {
    const result = await call("king3d_create_run", { prompt: "a small tin cup, MCP test" });
    expect(result.isError).toBe(false);
    const body = result.json as { runId: string; status: string; request: string };
    createdRunIds.push(body.runId);
    expect(body.status).toBe("needs_spec");
    // The request teaches the whole modelling vocabulary, since the builder
    // executes the answer literally - this is what the tool description promises.
    expect(body.request).toMatch(/primitive.*hollow.*cut.*array/s);
  });
});

describe("spec answer round trip", () => {
  const draft = {
    object: {
      category: "drinkware",
      name: "mcp test cup",
      description: "test",
      overall_dimensions_m: { value: [0.08, 0.08, 0.09], provenance: "inferred", confidence: 0.5 },
      symmetry: { value: "radial", provenance: "inferred", confidence: 0.5 },
    },
    components: [
      {
        id: "body",
        name: "Body",
        role: "vessel",
        identity_defining: true,
        geometry: { kind: "primitive", primitive: "cylinder", options: {}, shade_smooth: true },
        dimensions_m: { value: [0.07, 0.07, 0.09], provenance: "inferred", confidence: 0.5 },
        position_m: { value: [0, 0, 0.045], provenance: "inferred", confidence: 0.5 },
        material: "tin",
      },
    ],
    materials: [{ id: "tin", name: "Tin", base_color: [0.7, 0.7, 0.72, 1], metallic: 0.6, roughness: 0.4 }],
  };

  it("accepts a spec given as a JSON object", async () => {
    const created = await call("king3d_create_run", { prompt: "object-form test" });
    const runId = (created.json as { runId: string }).runId;
    createdRunIds.push(runId);

    const answered = await call("king3d_submit_spec_answer", { run_id: runId, spec: draft });
    expect(answered.isError, answered.text).toBe(false);
    const body = answered.json as { status: string; spec: { id: string } };
    expect(body.status).toBe("spec_ready");
    expect(body.spec.id).toBe(runId);
  });

  it("accepts a spec given as a JSON string", async () => {
    const created = await call("king3d_create_run", { prompt: "string-form test" });
    const runId = (created.json as { runId: string }).runId;
    createdRunIds.push(runId);

    const answered = await call("king3d_submit_spec_answer", { run_id: runId, spec: JSON.stringify(draft) });
    expect(answered.isError).toBe(false);
  });

  it("tolerates a spec wrapped in a markdown code fence", async () => {
    const created = await call("king3d_create_run", { prompt: "fenced-form test" });
    const runId = (created.json as { runId: string }).runId;
    createdRunIds.push(runId);

    const answered = await call("king3d_submit_spec_answer", {
      run_id: runId,
      spec: "```json\n" + JSON.stringify(draft) + "\n```",
    });
    expect(answered.isError).toBe(false);
  });

  it("rejects a spec that is not valid JSON, with a specific error", async () => {
    const created = await call("king3d_create_run", { prompt: "invalid-form test" });
    const runId = (created.json as { runId: string }).runId;
    createdRunIds.push(runId);

    const answered = await call("king3d_submit_spec_answer", { run_id: runId, spec: "this is not json" });
    expect(answered.isError).toBe(true);
    expect(answered.text).toContain("TOOL_OUTPUT_INVALID");
  });

  it("rejects a review request before the run has been built", async () => {
    const created = await call("king3d_create_run", { prompt: "unbuild test" });
    const runId = (created.json as { runId: string }).runId;
    createdRunIds.push(runId);
    await call("king3d_submit_spec_answer", { run_id: runId, spec: draft });

    const review = await call("king3d_request_review", { run_id: runId });
    expect(review.isError).toBe(true);
    expect(review.text).toContain("RUN_STATE_INVALID");
  });

  it("get_run reflects the accepted spec and clears the pending request", async () => {
    const created = await call("king3d_create_run", { prompt: "reflect test" });
    const runId = (created.json as { runId: string }).runId;
    createdRunIds.push(runId);
    await call("king3d_submit_spec_answer", { run_id: runId, spec: draft });

    const detail = await call("king3d_get_run", { run_id: runId });
    const body = detail.json as { spec: { object: { name: string } }; pending: Record<string, string> };
    expect(body.spec.object.name).toBe("mcp test cup");
    expect(body.pending["spec"]).toBeUndefined();
  });
});
