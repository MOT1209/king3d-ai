// ai3d dashboard - vanilla JS, no build step. Every action re-fetches the run
// from the server rather than tracking client-side state, so the UI can never
// drift from what the pipeline actually did.
//
// Loaded as a real ES module (see the importmap in index.html) because cdnjs's
// three.js package never shipped examples/js - OrbitControls and GLTFLoader
// 404 there for every recent version, which is why the module build is used
// instead of the classic global-script UMD pattern.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = { runId: null };

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    const err = new Error(data.message || `${method} ${path} failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
}

function toast(message, isError) {
  const el = $("#toast");
  const icon = isError ? "icon-x" : "icon-check";
  el.innerHTML = `<svg class="icon" aria-hidden="true" style="vertical-align:-2px;margin-right:6px"><use href="#${icon}"/></svg>${escapeHtml(message)}`;
  el.classList.toggle("error", !!isError);
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 4000);
}

const STATUS_LABEL = {
  needs_spec: "awaiting spec",
  spec_ready: "spec ready",
  built: "built",
  needs_review: "awaiting review",
  reviewed: "reviewed",
};

// ------------------------------------------------------------------ run list

async function refreshRunList() {
  const { data } = await api("GET", "/api/runs");
  const list = $("#run-list");
  list.innerHTML = "";
  for (const run of data.runs) {
    const li = document.createElement("li");
    li.className = "run-row" + (run.id === state.runId ? " active" : "");
    li.dataset.id = run.id;
    const scoreText = run.overall !== undefined ? run.overall.toFixed(2) : "-";
    li.innerHTML = `
      <span class="run-status status-${run.status}">${STATUS_LABEL[run.status] ?? run.status}</span>
      <span class="run-name">${escapeHtml(run.name || run.id)}</span>
      <span class="run-score">${scoreText}</span>
    `;
    li.addEventListener("click", () => openRun(run.id));
    list.appendChild(li);
  }
  if (data.runs.length === 0) {
    list.innerHTML = '<li class="empty">no runs yet</li>';
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------------ create run

async function submitNewRun(ev) {
  ev.preventDefault();
  const prompt = $("#new-prompt").value.trim();
  const hints = $("#new-hints").value.trim();
  const fileInput = $("#new-image");
  const file = fileInput.files[0];

  if (!prompt && !file) {
    toast("attach an image or write a prompt", true);
    return;
  }

  const body = {};
  if (prompt) body.prompt = prompt;
  if (hints) body.hints = hints;
  if (file) {
    body.imageBase64 = await fileToBase64(file);
    body.imageName = file.name;
  }

  const btn = $("#new-run-submit");
  btn.disabled = true;
  try {
    const { data } = await api("POST", "/api/runs", body);
    toast(`run ${data.runId} created - waiting for a spec`);
    $("#new-run-form").reset();
    $("#image-preview").hidden = true;
    await refreshRunList();
    await openRun(data.runId);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------ run detail

async function openRun(runId) {
  state.runId = runId;
  $$(".run-row").forEach((r) => r.classList.toggle("active", r.dataset.id === runId));
  $("#detail-empty").hidden = true;
  $("#detail").hidden = false;
  await renderRun();
}

async function renderRun() {
  if (!state.runId) return;
  const { data } = await api("GET", `/api/runs/${state.runId}`);
  const { summary, spec, repairedSpec, report, pending } = data;

  $("#detail-title").textContent = spec?.object?.name || summary.id;
  $("#detail-id").textContent = summary.id;
  $("#detail-status").textContent = STATUS_LABEL[summary.status] ?? summary.status;
  $("#detail-status").className = "run-status status-" + summary.status;

  renderSpecTab(spec, pending.spec);
  renderBuildTab(summary, report);
  renderReportTab(report);
  renderModelTab(summary);
  renderReviewTab(spec, repairedSpec, report, pending.review);
}

// ---- spec tab ----

function renderSpecTab(spec, pendingRequest) {
  const pane = $("#tab-spec");
  if (pendingRequest) {
    pane.innerHTML = `
      <p class="hint">This run needs a specification. Read the request below, look at the
      reference image if there is one, then paste a JSON answer.</p>
      <pre class="request-text">${escapeHtml(pendingRequest)}</pre>
      <textarea id="spec-answer" placeholder="paste the JSON answer here" rows="14"></textarea>
      <button id="spec-answer-submit">Submit spec</button>
    `;
    $("#spec-answer-submit").addEventListener("click", submitSpecAnswer);
  } else if (spec) {
    pane.innerHTML = `
      <p class="hint">Spec accepted. ${spec.components.length} component(s), ${spec.materials.length} material(s).</p>
      <pre class="request-text">${escapeHtml(JSON.stringify(spec, null, 2))}</pre>
    `;
  } else {
    pane.innerHTML = `<p class="hint">No spec yet.</p>`;
  }
}

async function submitSpecAnswer() {
  const text = $("#spec-answer").value;
  if (!text.trim()) return toast("paste the JSON answer first", true);
  const btn = $("#spec-answer-submit");
  btn.disabled = true;
  try {
    await api("POST", `/api/runs/${state.runId}/spec-answer`, { text });
    toast("spec accepted");
    await refreshRunList();
    await renderRun();
    switchTab("build");
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---- build tab ----

function renderBuildTab(summary, report) {
  const pane = $("#tab-build");
  const canBuild = summary.status === "spec_ready" || summary.status === "built" || summary.status === "reviewed";
  pane.innerHTML = `
    <button id="build-start" ${canBuild ? "" : "disabled"}>Build</button>
    <div id="build-log" class="build-log"></div>
  `;
  if (!canBuild) {
    pane.querySelector("#build-log").innerHTML = '<p class="hint">Waiting for a spec before this can build.</p>';
  }
  $("#build-start")?.addEventListener("click", () => streamBuild(`/api/runs/${state.runId}/build`));
}

// The build/rebuild routes are POST + text/event-stream. EventSource only
// supports GET, so progress is streamed by parsing SSE frames out of a plain
// fetch() body reader instead.
async function streamBuild(url) {
  const log = $("#build-log");
  log.innerHTML = "";
  const startBtn = document.getElementById("build-start") || document.getElementById("rebuild-start");
  if (startBtn) startBtn.disabled = true;

  try {
    const res = await fetch(url, { method: "POST" });
    if (!res.ok || !res.body) throw new Error(`build request failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleSseFrame(frame, log);
      }
    }
    await refreshRunList();
    await renderRun();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (startBtn) startBtn.disabled = false;
  }
}

function handleSseFrame(frame, log) {
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }

  if (event === "stage") {
    const row = document.createElement("div");
    row.className = "build-stage";
    row.innerHTML = `<span class="stage-name">${escapeHtml(parsed.name)}</span><span class="stage-detail">${escapeHtml(parsed.detail)}</span>`;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  } else if (event === "done") {
    const row = document.createElement("div");
    row.className = "build-done " + (parsed.passed ? "ok" : "fail");
    const icon = parsed.passed ? "icon-check" : "icon-x";
    row.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg>done - overall ${parsed.scores.overall.toFixed(2)} - ${parsed.passed ? "gates passed" : "gates failed"}`;
    log.appendChild(row);
    toast(parsed.passed ? "build passed" : "build finished with failing gates", !parsed.passed);
  } else if (event === "error") {
    const row = document.createElement("div");
    row.className = "build-done fail";
    row.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#icon-x"/></svg>error: ${escapeHtml(parsed.message)}`;
    log.appendChild(row);
    toast(parsed.message, true);
  }
}

// ---- report tab ----

function renderReportTab(report) {
  const pane = $("#tab-report");
  if (!report) {
    pane.innerHTML = '<p class="hint">No report yet - build the run first.</p>';
    return;
  }
  const scores = report.scores || {};
  const scoreRow = (label, value) =>
    `<div class="score"><span>${label}</span><span>${value === undefined ? "-" : value.toFixed(2)}</span></div>`;

  const gateRows = (report.gates || [])
    .map((g) => {
      const cls = g.passed ? "pass" : g.severity;
      const icon = g.passed ? "icon-check" : g.severity === "error" ? "icon-x" : "icon-alert";
      const label = g.passed ? "PASS" : g.severity === "error" ? "FAIL" : "WARN";
      return `<div class="gate ${cls}"><svg class="icon" aria-hidden="true"><use href="#${icon}"/></svg><span title="${label}">${escapeHtml(g.id)}</span><span>${escapeHtml(g.message)}</span></div>`;
    })
    .join("");

  pane.innerHTML = `
    <div class="scores">
      ${scoreRow("geometry", scores.geometry)}
      ${scoreRow("material", scores.material)}
      ${scoreRow("optimization", scores.optimization)}
      ${scoreRow("export", scores.export)}
      ${scoreRow("similarity", scores.similarity)}
      <div class="score overall"><span>overall</span><span>${scores.overall === undefined ? "-" : scores.overall.toFixed(2)}</span></div>
    </div>
    <div class="gates">${gateRows}</div>
    <img class="contact-sheet" src="/api/runs/${state.runId}/files/contact_sheet.png" alt="contact sheet" />
  `;
}

// ---- model tab ----

let viewerScene, viewerCamera, viewerRenderer, viewerControls, viewerModel, viewerAnimating;

function renderModelTab(summary) {
  const pane = $("#tab-model");
  if (!summary.hasGlb) {
    pane.innerHTML = '<p class="hint">No exported GLB yet.</p>';
    return;
  }
  pane.innerHTML = `<div id="viewer-stage"></div>`;
  initViewer(`/api/runs/${state.runId}/files/export/model.glb`);
}

function initViewer(glbUrl) {
  const stage = $("#viewer-stage");
  stage.innerHTML = "";

  viewerScene = new THREE.Scene();
  viewerScene.background = new THREE.Color(0x14161a);
  viewerCamera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
  viewerRenderer = new THREE.WebGLRenderer({ antialias: true });
  stage.appendChild(viewerRenderer.domElement);
  viewerControls = new OrbitControls(viewerCamera, viewerRenderer.domElement);
  viewerControls.enableDamping = true;
  viewerControls.autoRotate = true;
  viewerControls.autoRotateSpeed = 1.6;

  viewerScene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2620, 2.0));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 4, 5);
  viewerScene.add(key);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.8);
  fill.position.set(-4, 1, -2);
  viewerScene.add(fill);

  function resize() {
    const w = stage.clientWidth || 400;
    const h = stage.clientHeight || 400;
    viewerRenderer.setSize(w, h, false);
    viewerRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    viewerCamera.aspect = w / h;
    viewerCamera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(stage);

  new GLTFLoader().load(
    glbUrl,
    (gltf) => {
      if (viewerModel) viewerScene.remove(viewerModel);
      viewerModel = gltf.scene;
      viewerScene.add(viewerModel);
      const box = new THREE.Box3().setFromObject(viewerModel);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.length() / 2, 1e-4);
      viewerCamera.near = radius / 100;
      viewerCamera.far = radius * 100;
      const distance = radius / Math.sin((viewerCamera.fov * Math.PI) / 360);
      viewerCamera.position.set(centre.x + distance * 0.6, centre.y + distance * 0.45, centre.z + distance * 0.8);
      viewerCamera.updateProjectionMatrix();
      viewerControls.target.copy(centre);
      viewerControls.update();
    },
    undefined,
    () => toast("could not load the GLB", true),
  );

  if (!viewerAnimating) {
    viewerAnimating = true;
    (function animate() {
      requestAnimationFrame(animate);
      if (viewerControls) viewerControls.update();
      if (viewerRenderer && viewerScene && viewerCamera) viewerRenderer.render(viewerScene, viewerCamera);
    })();
  }
}

// ---- review tab ----

function renderReviewTab(spec, repairedSpec, report, pendingRequest) {
  const pane = $("#tab-review");
  if (!spec) {
    pane.innerHTML = '<p class="hint">Build the run first.</p>';
    return;
  }
  if (pendingRequest) {
    pane.innerHTML = `
      <p class="hint">Look at the contact sheet in the Report tab, then paste the review verdict.</p>
      <pre class="request-text">${escapeHtml(pendingRequest)}</pre>
      <textarea id="review-answer" placeholder="paste the JSON verdict here" rows="14"></textarea>
      <button id="review-answer-submit">Submit review</button>
    `;
    $("#review-answer-submit").addEventListener("click", submitReviewAnswer);
    return;
  }

  const review = report?.review;
  let html = `<button id="review-start">Request a review</button>`;
  if (review) {
    html += `
      <div class="review-summary">
        <div><strong>similarity</strong> ${review.similarity.toFixed(2)} &middot; <strong>verdict</strong> ${escapeHtml(review.verdict)}</div>
        <p>${escapeHtml(review.observations)}</p>
      </div>
      <div class="defects">
        ${(review.defects || [])
          .map((d) => `<div class="defect ${d.severity}"><strong>${d.severity}</strong> ${escapeHtml(d.id)}: ${escapeHtml(d.problem)}</div>`)
          .join("")}
      </div>
    `;
    if (repairedSpec) {
      html += `<button id="rebuild-start">Rebuild from repaired spec</button>`;
    }
  }
  pane.innerHTML = html;
  $("#review-start")?.addEventListener("click", requestReview);
  $("#rebuild-start")?.addEventListener("click", () => streamBuild(`/api/runs/${state.runId}/rebuild`));
}

async function requestReview() {
  const btn = $("#review-start");
  btn.disabled = true;
  try {
    await api("POST", `/api/runs/${state.runId}/review`);
    await renderRun();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitReviewAnswer() {
  const text = $("#review-answer").value;
  if (!text.trim()) return toast("paste the JSON verdict first", true);
  const btn = $("#review-answer-submit");
  btn.disabled = true;
  try {
    await api("POST", `/api/runs/${state.runId}/review-answer`, { text });
    toast("review recorded");
    await refreshRunList();
    await renderRun();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ tabs

function switchTab(name) {
  $$(".tab-button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-pane").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
}

// ------------------------------------------------------------------ init

document.addEventListener("DOMContentLoaded", () => {
  $("#new-run-form").addEventListener("submit", submitNewRun);
  $("#new-image").addEventListener("change", (e) => {
    const file = e.target.files[0];
    const preview = $("#image-preview");
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
  });

  // The <input type="file"> already covers the whole drop label and handles
  // drop natively; this only adds the visual dragover state on top of it.
  const dropZone = $(".file-drop");
  ["dragenter", "dragover"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    }),
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, () => dropZone.classList.remove("dragover")),
  );

  $$(".tab-button").forEach((b) =>
    b.addEventListener("click", () => {
      switchTab(b.dataset.tab);
      $$(".tab-button").forEach((btn) => btn.setAttribute("aria-selected", String(btn === b)));
    }),
  );

  refreshRunList();
  setInterval(refreshRunList, 8000);
});
