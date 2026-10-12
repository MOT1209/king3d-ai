import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newRunId, runPaths } from "../../src/pipeline/run.ts";
import { apiEditRun, apiListRevisions, apiRevertRun } from "../../src/server/routes.ts";
import { paths } from "../../src/core/config.ts";
import type { SceneSpec } from "../../src/spec/scene-spec.ts";

// Same convention as routes.test.ts: runs live under the real runs/ directory,
// so each test run is tagged and swept up afterwards.
const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((id) => rm(runPaths(id).dir, { recursive: true, force: true })));
});

async function makeRun(): Promise<string> {
  const id = newRunId("edit");
  created.push(id);
  const rp = runPaths(id);
  await mkdir(rp.dir, { recursive: true });
  const mug = await readFile(join(paths.root, "src", "spec", "fixtures", "mug.json"), "utf8");
  await writeFile(rp.spec, mug, "utf8");
  return id;
}

const widen = { path: "components.handle.dimensions_m.value", value: [0.08, 0.064, 0.012] };

async function repaired(id: string): Promise<SceneSpec> {
  return JSON.parse(await readFile(join(runPaths(id).dir, "spec.repaired.json"), "utf8")) as SceneSpec;
}

describe("apiEditRun", () => {
  it("applies an allowed edit to the working spec and records a revision", async () => {
    const id = await makeRun();
    const result = await apiEditRun(id, { fixes: [widen] });
    expect(result.status).toBe(200);
    expect((result.body as { rev: number }).rev).toBe(1);

    const handle = (await repaired(id)).components.find((c) => c.id === "handle");
    expect(handle?.dimensions_m.value).toEqual([0.08, 0.064, 0.012]);
    // The built spec is untouched: edits live in spec.repaired.json only.
    const original = JSON.parse(await readFile(runPaths(id).spec, "utf8")) as SceneSpec;
    expect(original.components.find((c) => c.id === "handle")?.dimensions_m.value).toEqual([0.064, 0.064, 0.012]);
  });

  it("accumulates edits instead of starting over each time", async () => {
    const id = await makeRun();
    await apiEditRun(id, { fixes: [widen] });
    const second = await apiEditRun(id, { fixes: [{ path: "materials.ceramic_white.roughness", value: 0.9 }] });
    expect((second.body as { rev: number }).rev).toBe(2);

    const spec = await repaired(id);
    expect(spec.components.find((c) => c.id === "handle")?.dimensions_m.value).toEqual([0.08, 0.064, 0.012]);
    expect(spec.materials.find((m) => m.id === "ceramic_white")?.roughness).toBe(0.9);
  });

  it("rejects a path outside the repair vocabulary (no restructuring)", async () => {
    const id = await makeRun();
    const result = await apiEditRun(id, { fixes: [{ path: "components.handle.geometry.kind", value: 1 }] });
    expect(result.status).toBe(400);
    expect(existsSync(join(runPaths(id).dir, "spec.repaired.json"))).toBe(false);
  });

  it("rejects an empty edit and an unknown component", async () => {
    const id = await makeRun();
    expect((await apiEditRun(id, { fixes: [] })).status).toBe(400);
    const unknown = await apiEditRun(id, { fixes: [{ path: "components.nope.dimensions_m.value", value: [1, 1, 1] }] });
    expect(unknown.status).toBe(400);
  });

  it("rejects a value of the wrong shape and leaves the spec alone", async () => {
    const id = await makeRun();
    const result = await apiEditRun(id, { fixes: [{ path: "components.handle.dimensions_m.value", value: 0.5 }] });
    expect(result.status).toBe(400);
    expect(existsSync(join(runPaths(id).dir, "spec.repaired.json"))).toBe(false);
  });

  it("404s for a run that does not exist", async () => {
    expect((await apiEditRun("edit_nope", { fixes: [widen] })).status).toBe(404);
  });
});

describe("revisions and revert", () => {
  it("lists revisions in order", async () => {
    const id = await makeRun();
    await apiEditRun(id, { fixes: [widen] });
    await apiEditRun(id, { fixes: [{ path: "materials.ceramic_white.metallic", value: 0.3 }] });
    const list = (await apiListRevisions(id)).body as { revisions: Array<{ rev: number }> };
    expect(list.revisions.map((r) => r.rev)).toEqual([1, 2]);
  });

  it("reverts to an earlier revision, and rev 0 returns to the built spec", async () => {
    const id = await makeRun();
    await apiEditRun(id, { fixes: [widen] });
    await apiEditRun(id, { fixes: [{ path: "materials.ceramic_white.roughness", value: 0.9 }] });

    await apiRevertRun(id, 1);
    let spec = await repaired(id);
    expect(spec.materials.find((m) => m.id === "ceramic_white")?.roughness).not.toBe(0.9);
    expect(spec.components.find((c) => c.id === "handle")?.dimensions_m.value).toEqual([0.08, 0.064, 0.012]);

    await apiRevertRun(id, 0);
    spec = await repaired(id);
    expect(spec.components.find((c) => c.id === "handle")?.dimensions_m.value).toEqual([0.064, 0.064, 0.012]);

    // Later revisions are kept, so redo is a revert to a higher number.
    const list = (await apiListRevisions(id)).body as { revisions: unknown[] };
    expect(list.revisions).toHaveLength(2);
  });

  it("rejects a revision that does not exist", async () => {
    const id = await makeRun();
    expect((await apiRevertRun(id, 7)).status).toBe(400);
    expect((await apiRevertRun(id, -1)).status).toBe(400);
  });
});
