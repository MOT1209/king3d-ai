# TRELLIS.2 inference service

The generative "brain" for King3D's generative mode. It wraps the Microsoft
[TRELLIS.2](https://github.com/microsoft/TRELLIS.2) image/text → 3D model behind
a small HTTP API so the King3D Node pipeline can request a raw base mesh (GLB
with PBR), then import, repair and make it game-ready through the existing
quality gates.

- Boundary: HTTP (`/healthz`, `/generate`). The GPU/CUDA concern stays entirely
  on this side of the boundary.
- Deployment: the same image runs **locally** or in the **cloud**. King3D points
  at it with `KING3D_TRELLIS_URL` (default `http://127.0.0.1:8900`); nothing else
  changes between the two.
- Client: `src/integrations/trellis/client.ts`.

## Step 0 — Licence review (reviewed 2026-10-11)

Findings from the primary sources (not legal advice — confirm with counsel before
a commercial launch):

- [x] **Code licence — MIT.** `microsoft/TRELLIS.2` `LICENSE` is MIT (© Microsoft).
- [x] **Weights licence — MIT.** `microsoft/TRELLIS.2-4B` on Hugging Face carries
      `license: mit`; the model card states "This model is released under the MIT
      License." MIT permits commercial use and redistribution of the weights.
- [x] **Dependency catch — CONFIRMED BLOCKING for commercial use.** `nvdiffrast`
      and `nvdiffrec` (NVIDIA) are **non-commercial** (NVIDIA Source Code License:
      "may be used … only … non-commercially"). An earlier reading hoped they were
      preview-only and skippable — **a static source check of the cloned repo
      (2026-10-11) disproves that.** The GLB export function itself,
      `o-voxel/o_voxel/postprocess.py::to_glb`, imports nvdiffrast at module level
      (line 10: `import nvdiffrast.torch as dr`) and uses it to **bake the
      texture**: `dr.RasterizeCudaContext()` (L230), `dr.rasterize()` (L237),
      `dr.interpolate()` (L249). So the stock image→GLB-with-PBR path **requires
      nvdiffrast at import and at runtime** — it is on the critical path, not just
      the optional preview render. Omitting the `setup.sh` flag is NOT sufficient.
- [x] **VRAM — 24 GB minimum** (model card: NVIDIA GPU ≥24 GB, Linux only,
      CUDA 12.4, verified on A100/H100).

**Verdict: nvdiffrast IS a blocker for a COMMERCIAL build of the stock pipeline.**
Code + weights are MIT, but the official textured-GLB export depends on the
non-commercial NVIDIA rasterizer. Options:

1. **Non-commercial / research use** — use the stock pipeline as-is (MIT + NVIDIA
   non-commercial terms). Fine for research, not for a commercial product.
2. **Replace the rasterizer** — swap the three `dr.*` calls in `to_glb` for a
   commercially-licensed rasterizer (e.g. a PyTorch/`torch` rasterization, or the
   reimplementation the ComfyUI community did to drop nvdiffrast/nvdiffrec —
   *unverified that it covers these exact calls; confirm before relying on it*).
3. **Geometry-only export** — take `mesh.vertices/faces` from `pipeline.run` and
   export via `trimesh`, skipping `to_glb`'s texture bake. Loses TRELLIS's baked
   PBR texture (King3D can re-UV/bake its own). Avoids nvdiffrast entirely —
   needs verification that nothing else on `pipeline.run` imports it at module
   level (the renderers import it lazily, so they are safe if not called).
4. **Licence nvdiffrast commercially from NVIDIA**, or re-check NVIDIA's current
   terms for it.

Still to record (your call, with counsel):
- [ ] Intended use: _(commercial / research — fill in)_
- [ ] Confirmed by / date: _(fill in)_

Until the model is actually wired in, `/generate` returns HTTP 501 and King3D's
**mock provider** is the supported path:

```bash
KING3D_TRELLIS_MODE=mock king3d gen-trellis --image inputs/example.png
```

## Running the shell (no model yet)

```bash
cd services/trellis
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8900
curl localhost:8900/healthz        # {"ok": true, "model_loaded": false, ...}
```

## Wiring the model (after Step 0)

1. Install TRELLIS.2 via its `setup.sh`. **Research/non-commercial** build:
   `. ./setup.sh --new-env --basic --flash-attn --nvdiffrast --nvdiffrec
   --cumesh --o-voxel --flexgemm`. For a **commercial** build you must first
   resolve the nvdiffrast dependency in `to_glb` (see Step 0, options 2–4) —
   omitting the flag alone will make `o_voxel.postprocess.to_glb` fail to import.
   Swap the Docker base image for a CUDA 12.4 one; target a GPU with ≥24 GB VRAM.
2. Implement `_load_pipeline()` and the inference block in `app.py` (both are
   marked with the exact lines to fill in). Export GLB **with PBR** so the
   materials survive into King3D. (If you take Step 0 option 3 — geometry-only —
   skip `to_glb` and export `mesh.vertices/faces` via `trimesh` instead.)
3. Point King3D at it: `KING3D_TRELLIS_MODE=http KING3D_TRELLIS_URL=http://<host>:8900`.

## API

### `GET /healthz`
`{ "ok": true, "model_id": "...", "model_loaded": false }`

### `POST /generate` (multipart)
Fields: `image` (file, optional), `prompt` (string, optional), `seed` (int,
optional). At least one of `image`/`prompt` is required. On success returns the
GLB bytes with `Content-Type: model/gltf-binary`.
