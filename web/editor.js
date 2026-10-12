// King3D editor: pick a part in the 3D view, edit its size / placement /
// material, rebuild, undo.
//
// Edits are never applied to the scene. Each one becomes a `{ path, value }`
// fix on the SceneSpec - the same vocabulary the review stage uses - and the
// server rebuilds from the edited spec. That is why the inspector can only
// offer what the server will accept: dimensions, position, rotation, and
// material colour / metallic / roughness.
import * as THREE from "three";

const AXES = ["x", "y", "z"];

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round = (n, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

// The spec the dashboard receives is the raw JSON on disk, so optional fields
// (rotation_deg, ...) can be absent; the server fills defaults, the browser must too.
const vec = (field, fallback = [0, 0, 0]) => field?.value ?? fallback;

function hexFromRgba(rgba) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${h(rgba[0])}${h(rgba[1])}${h(rgba[2])}`;
}

function rgbaFromHex(hex, alpha) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha].map((v) => round(v, 4));
}

/** Component ids that failed a gate, read from the gates' own `data` payloads. */
export function failingComponentIds(gates) {
  const ids = new Set();
  for (const gate of gates || []) {
    if (gate.passed || !gate.data) continue;
    const d = gate.data;
    for (const id of d.missing || []) ids.add(id);
    for (const o of d.offenders || []) ids.add(o.id);
    for (const m of d.meshes || []) ids.add(typeof m === "string" ? m : m.name);
  }
  return ids;
}

export function createEditor({ api, toast, escapeHtml, rebuild }) {
  let ctx = null; // { scene, camera, renderer, controls, model, spec, gates, runId }
  let selected = null; // component id
  let pending = new Map(); // path -> value
  let outline = null;
  const failOutlines = [];

  const componentOf = (id) => ctx?.spec?.components?.find((c) => c.id === id);
  const materialOf = (id) => ctx?.spec?.materials?.find((m) => m.id === id);

  function nodeForComponent(id) {
    let found = null;
    ctx.model.traverse((o) => {
      if (!found && o.name === id) found = o;
    });
    return found;
  }

  function componentIdFromObject(object) {
    const ids = new Set((ctx.spec.components || []).map((c) => c.id));
    for (let o = object; o; o = o.parent) if (ids.has(o.name)) return o.name;
    return null;
  }

  function clearOutlines() {
    if (outline) ctx.scene.remove(outline);
    outline = null;
    while (failOutlines.length) ctx.scene.remove(failOutlines.pop());
  }

  function drawOutlines() {
    clearOutlines();
    for (const id of failingComponentIds(ctx.gates)) {
      const node = nodeForComponent(id);
      if (!node) continue;
      const box = new THREE.BoxHelper(node, 0xff5c5c);
      ctx.scene.add(box);
      failOutlines.push(box);
    }
    if (selected) {
      const node = nodeForComponent(selected);
      if (node) {
        outline = new THREE.BoxHelper(node, 0x4fd18b);
        ctx.scene.add(outline);
      }
    }
  }

  function pick(ev) {
    const rect = ctx.renderer.domElement.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const caster = new THREE.Raycaster();
    caster.setFromCamera(pointer, ctx.camera);
    const hit = caster.intersectObject(ctx.model, true)[0];
    select(hit ? componentIdFromObject(hit.object) : null);
  }

  /** Attach to a freshly loaded model. Called by the viewer each time it loads. */
  function attach(next) {
    detach();
    ctx = next;
    selected = null;
    pending = new Map();
    // A spinning model cannot be clicked reliably, so editable runs stop rotating.
    if (ctx.spec?.components) ctx.controls.autoRotate = false;

    // Distinguish a click from an orbit drag so rotating the view never selects.
    const el = ctx.renderer.domElement;
    let down = null;
    ctx.onDown = (e) => (down = { x: e.clientX, y: e.clientY });
    ctx.onUp = (e) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) pick(e);
      down = null;
    };
    el.addEventListener("pointerdown", ctx.onDown);
    el.addEventListener("pointerup", ctx.onUp);

    drawOutlines();
    render();
    refreshRevisions();
  }

  function detach() {
    if (!ctx) return;
    const el = ctx.renderer.domElement;
    el.removeEventListener("pointerdown", ctx.onDown);
    el.removeEventListener("pointerup", ctx.onUp);
    clearOutlines();
    ctx = null;
  }

  function select(id) {
    selected = id;
    drawOutlines();
    render();
  }

  // ---------------------------------------------------------------- inspector

  function vecField(label, path, values, step) {
    const cells = AXES.map((axis, i) => {
      const current = pending.has(path) ? pending.get(path)[i] : values[i];
      return `<label class="ed-axis">${axis}<input type="number" step="${step}" data-path="${path}" data-index="${i}" value="${round(current)}" /></label>`;
    }).join("");
    return `<div class="ed-row"><span class="ed-label">${label}</span>${cells}</div>`;
  }

  function render() {
    const panel = document.getElementById("editor-panel");
    if (!panel) return;
    if (!ctx?.spec?.components) {
      panel.innerHTML = `<p class="hint">Editing needs a SceneSpec run. Generative runs can be viewed, not edited here.</p>`;
      return;
    }

    const failing = failingComponentIds(ctx.gates);
    const c = selected ? componentOf(selected) : null;
    let html = `<h3>Editor</h3><p class="hint">Click a part. <span class="ed-fail">Red</span> boxes failed a quality gate.</p>`;

    html += `<ul class="ed-parts">${ctx.spec.components
      .map(
        (p) =>
          `<li><button type="button" class="ed-part${p.id === selected ? " active" : ""}${failing.has(p.id) ? " failing" : ""}" data-part="${escapeHtml(p.id)}">${escapeHtml(p.name || p.id)}</button></li>`,
      )
      .join("")}</ul>`;

    if (c) {
      const base = `components.${c.id}`;
      const m = materialOf(c.material);
      html += `<div class="ed-group"><h4>${escapeHtml(c.name || c.id)}</h4>`;
      html += vecField("size (m)", `${base}.dimensions_m.value`, vec(c.dimensions_m), 0.005);
      html += vecField("position (m)", `${base}.position_m.value`, vec(c.position_m), 0.005);
      html += vecField("rotation (°)", `${base}.rotation_deg.value`, vec(c.rotation_deg), 1);
      if (m) {
        const mp = `materials.${m.id}`;
        const color = pending.has(`${mp}.base_color`) ? pending.get(`${mp}.base_color`) : m.base_color ?? [0.8, 0.8, 0.8, 1];
        const metallic = pending.has(`${mp}.metallic`) ? pending.get(`${mp}.metallic`) : m.metallic ?? 0;
        const roughness = pending.has(`${mp}.roughness`) ? pending.get(`${mp}.roughness`) : m.roughness ?? 0.5;
        html += `<div class="ed-row"><span class="ed-label">colour</span>
          <input type="color" data-color="${mp}.base_color" data-alpha="${color[3] ?? 1}" value="${hexFromRgba(color)}" /></div>
          <div class="ed-row"><span class="ed-label">metallic</span>
          <input type="range" min="0" max="1" step="0.01" data-scalar="${mp}.metallic" value="${metallic}" /></div>
          <div class="ed-row"><span class="ed-label">roughness</span>
          <input type="range" min="0" max="1" step="0.01" data-scalar="${mp}.roughness" value="${roughness}" /></div>
          <p class="hint">Material <code>${escapeHtml(m.id)}</code> may be shared by other parts.</p>`;
      }
      html += `</div>`;
    }

    html += `<div class="ed-actions">
      <button type="button" id="ed-apply" ${pending.size ? "" : "disabled"}>Apply &amp; rebuild${pending.size ? ` (${pending.size})` : ""}</button>
      <button type="button" id="ed-discard" ${pending.size ? "" : "disabled"}>Discard</button>
    </div>
    <div class="ed-history"><label class="ed-label" for="ed-rev">History</label>
      <select id="ed-rev"></select><button type="button" id="ed-revert">Revert</button></div>`;

    panel.innerHTML = html;
    wire(panel);
    fillRevisions();
  }

  function wire(panel) {
    panel.querySelectorAll("[data-part]").forEach((b) => b.addEventListener("click", () => select(b.dataset.part)));

    panel.querySelectorAll("input[data-path]").forEach((input) =>
      input.addEventListener("change", () => {
        const path = input.dataset.path;
        const row = [...panel.querySelectorAll(`input[data-path="${path}"]`)].map((i) => num(i.value));
        pending.set(path, row);
        render();
      }),
    );
    panel.querySelectorAll("input[data-scalar]").forEach((input) =>
      input.addEventListener("change", () => {
        pending.set(input.dataset.scalar, clamp01(num(input.value)));
        render();
      }),
    );
    panel.querySelectorAll("input[data-color]").forEach((input) =>
      input.addEventListener("change", () => {
        pending.set(input.dataset.color, rgbaFromHex(input.value, num(input.dataset.alpha, 1)));
        render();
      }),
    );

    panel.querySelector("#ed-discard")?.addEventListener("click", () => {
      pending = new Map();
      render();
    });
    panel.querySelector("#ed-apply")?.addEventListener("click", applyAndRebuild);
    panel.querySelector("#ed-revert")?.addEventListener("click", revert);
  }

  // ---------------------------------------------------------------- actions

  async function applyAndRebuild() {
    const fixes = [...pending].map(([path, value]) => ({ path, value }));
    const btn = document.getElementById("ed-apply");
    if (btn) btn.disabled = true;
    try {
      await api("POST", `/api/runs/${ctx.runId}/edit`, { fixes });
      pending = new Map();
      await rebuild(ctx.runId); // builds spec.repaired.json into a new run and opens it
    } catch (e) {
      toast(e.message, true);
      render();
    }
  }

  let revisions = [];
  async function refreshRevisions() {
    try {
      const { data } = await api("GET", `/api/runs/${ctx.runId}/revisions`);
      revisions = data.revisions || [];
      fillRevisions();
    } catch {
      revisions = [];
    }
  }

  function fillRevisions() {
    const select = document.getElementById("ed-rev");
    if (!select) return;
    select.innerHTML =
      `<option value="0">original (built spec)</option>` +
      revisions.map((r) => `<option value="${r.rev}">edit ${r.rev} · ${r.fixes.length} change(s)</option>`).join("");
  }

  async function revert() {
    const rev = Number(document.getElementById("ed-rev")?.value ?? 0);
    try {
      await api("POST", `/api/runs/${ctx.runId}/revert`, { rev });
      toast(rev === 0 ? "reverted to the built spec" : `reverted to edit ${rev}`);
      await rebuild(ctx.runId);
    } catch (e) {
      toast(e.message, true);
    }
  }

  return { attach, detach, render };
}
