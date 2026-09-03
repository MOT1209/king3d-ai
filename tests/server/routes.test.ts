import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  apiCreateRun,
  apiGetRun,
  apiRequestReview,
  apiReviewAnswer,
  apiSpecAnswer,
} from "../../src/server/routes.ts";
import { listRuns } from "../../src/server/runs-list.ts";
import { runPaths } from "../../src/pipeline/run.ts";

// Routes operate on the real runs/ directory (paths.runs is a fixed constant
// derived from the project root, not injectable), so every run this suite
// creates is tagged and swept up afterwards rather than using a fake root.
const createdRunIds: string[] = [];
async function cleanup(): Promise<void> {
  await Promise.all(createdRunIds.splice(0).map((id) => rm(runPaths(id).dir, { recursive: true, force: true })));
}
afterEach(cleanup);

async function createRun(input: Parameters<typeof apiCreateRun>[0]): Promise<string> {
  const result = await apiCreateRun(input);
  expect(result.status).toBe(202);
  const id = (result.body as { runId: string }).runId;
  createdRunIds.push(id);
  return id;
}

describe("apiCreateRun", () => {
  it("rejects a run with neither an image nor a prompt", async () => {
    const result = await apiCreateRun({});
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("CONFIG_INVALID");
  });

  it("accepts a text-only run and returns the pending spec request", async () => {
    const result = await apiCreateRun({ prompt: "a small wooden stool" });
    expect(result.status).toBe(202);
    const body = result.body as { runId: string; status: string; request: string };
    createdRunIds.push(body.runId);
    expect(body.status).toBe("needs_spec");
    // The request has to teach the whole modelling vocabulary, since the
    // builder executes the answer literally.
    expect(body.request).toContain("a small wooden stool");
    expect(body.request).toMatch(/primitive.*hollow.*cut.*array/s);
  });

  it("decodes and stores an uploaded reference image", async () => {
    const png1x1 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const id = await createRun({ imageBase64: png1x1, imageName: "ref.png" });
    const detail = await apiGetRun(id);
    expect(detail.status).toBe(200);
    expect((detail.body as { reference: string | null }).reference).toBe("reference");
  });
});

describe("apiGetRun", () => {
  it("404s for a run that does not exist", async () => {
    const result = await apiGetRun("no_such_run_xyz");
    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toBe("RUN_NOT_FOUND");
  });

  it("shows the pending request text until answered", async () => {
    const id = await createRun({ prompt: "a ceramic bowl" });
    const detail = await apiGetRun(id);
    const body = detail.body as { pending: Record<string, string>; spec: unknown };
    expect(body.pending["spec"]).toBeTruthy();
    expect(body.spec).toBeUndefined();
  });
});

describe("apiSpecAnswer", () => {
  it("rejects text that is not JSON", async () => {
    const id = await createRun({ prompt: "a ceramic bowl" });
    const result = await apiSpecAnswer(id, { text: "not json at all" });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("TOOL_OUTPUT_INVALID");
  });

  it("rejects an answer missing required fields", async () => {
    const id = await createRun({ prompt: "a ceramic bowl" });
    const result = await apiSpecAnswer(id, { text: JSON.stringify({ object: {} }) });
    expect(result.status).toBe(400);
  });

  it("accepts a valid draft, completes it, and writes spec.json", async () => {
    const id = await createRun({ prompt: "a ceramic bowl" });
    const draft = {
      object: {
        category: "drinkware",
        name: "test bowl",
        description: "a simple bowl",
        overall_dimensions_m: { value: [0.15, 0.15, 0.06], provenance: "inferred", confidence: 0.5 },
        symmetry: { value: "radial", provenance: "inferred", confidence: 0.5 },
      },
      components: [
        {
          id: "bowl",
          name: "Bowl",
          role: "vessel",
          identity_defining: true,
          geometry: { kind: "primitive", primitive: "uv_sphere", options: {}, shade_smooth: true },
          dimensions_m: { value: [0.15, 0.15, 0.06], provenance: "inferred", confidence: 0.5 },
          position_m: { value: [0, 0, 0.03], provenance: "inferred", confidence: 0.5 },
          material: "clay",
        },
      ],
      materials: [{ id: "clay", name: "Clay", base_color: [0.6, 0.4, 0.3, 1], metallic: 0, roughness: 0.7 }],
    };

    const result = await apiSpecAnswer(id, { text: JSON.stringify(draft) });
    expect(result.status).toBe(200);
    const body = result.body as { status: string; spec: { id: string; object: { name: string } } };
    expect(body.status).toBe("spec_ready");
    expect(body.spec.id).toBe(id);
    expect(body.spec.object.name).toBe("test bowl");

    // Answering also clears the pending request from the run's detail view.
    const detail = await apiGetRun(id);
    const detailBody = detail.body as { pending: Record<string, string>; spec: unknown };
    expect(detailBody.pending["spec"]).toBeUndefined();
    expect(detailBody.spec).toBeTruthy();
  });

  it("tolerates an answer wrapped in a markdown code fence", async () => {
    const id = await createRun({ prompt: "a ceramic bowl" });
    const draft = {
      object: {
        category: "drinkware",
        name: "fenced bowl",
        description: "d",
        overall_dimensions_m: { value: [0.1, 0.1, 0.05], provenance: "inferred", confidence: 0.5 },
        symmetry: { value: "radial", provenance: "inferred", confidence: 0.5 },
      },
      components: [
        {
          id: "bowl",
          name: "Bowl",
          role: "vessel",
          identity_defining: true,
          geometry: { kind: "primitive", primitive: "uv_sphere", options: {}, shade_smooth: true },
          dimensions_m: { value: [0.1, 0.1, 0.05], provenance: "inferred", confidence: 0.5 },
          position_m: { value: [0, 0, 0.025], provenance: "inferred", confidence: 0.5 },
          material: "clay",
        },
      ],
      materials: [{ id: "clay", name: "Clay", base_color: [0.6, 0.4, 0.3, 1], metallic: 0, roughness: 0.7 }],
    };
    const result = await apiSpecAnswer(id, { text: "```json\n" + JSON.stringify(draft) + "\n```" });
    expect(result.status).toBe(200);
  });
});

describe("apiRequestReview", () => {
  it("refuses a run with no contact sheet yet", async () => {
    const id = await createRun({ prompt: "a ceramic bowl" });
    const result = await apiRequestReview(id);
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toBe("RUN_STATE_INVALID");
  });

  it("404s for an unknown run", async () => {
    const result = await apiRequestReview("no_such_run_xyz");
    expect(result.status).toBe(404);
  });
});

describe("apiReviewAnswer", () => {
  it("rejects a verdict with an out-of-range similarity", async () => {
    const id = await createRun({ prompt: "a ceramic bowl" });
    const result = await apiReviewAnswer(id, {
      text: JSON.stringify({ similarity: 2, verdict: "accept", observations: "x" }),
    });
    expect(result.status).toBe(400);
  });
});

describe("listRuns", () => {
  it("excludes runs/fixtures - it is a cache directory, not a run", async () => {
    const runs = await listRuns();
    expect(runs.some((r) => r.id === "fixtures")).toBe(false);
  });

  it("includes a freshly created run as needs_spec", async () => {
    const id = await createRun({ prompt: "a small tin cup" });
    const runs = await listRuns();
    const entry = runs.find((r) => r.id === id);
    expect(entry?.status).toBe("needs_spec");
  });
});
