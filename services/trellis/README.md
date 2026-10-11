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
- [x] **Dependency catch — resolved.** `nvdiffrast` and `nvdiffrec` (NVIDIA) are
      **non-commercial** (NVIDIA Source Code License: "may be used … only …
      non-commercially"). TRELLIS.2's own README scopes them to *"rendering
      generated 3D assets"* and makes them **optional `setup.sh` flags**
      (`--nvdiffrast --nvdiffrec`). The image→GLB path uses `o-voxel`, not these.
      → **Install without those two flags and skip the preview-render step, and
      the pipeline is MIT-only = commercial-safe.**
- [x] **VRAM — 24 GB minimum** (model card: NVIDIA GPU ≥24 GB, Linux only,
      CUDA 12.4, verified on A100/H100).

Residual check before shipping commercially:
- [ ] Dry-install with `. ./setup.sh --basic --flash-attn --o-voxel --cumesh
      --flexgemm` (no `--nvdiffrast/--nvdiffrec`) and confirm `pipeline.run` +
      `o_voxel.postprocess.to_glb` import and run without pulling nvdiffrast.
      King3D does its own decimation, so TRELLIS's `mesh.simplify(...)`
      (commented "nvdiffrast limit") can be skipped if it transitively needs it.
- [ ] Record the intended use and counsel sign-off:
      Intended use: _(commercial / research — fill in)_
      Confirmed by / date: _(fill in)_

Verdict: **not blocking for commercial use** provided the NVIDIA render extras
are omitted. Until the model is actually wired in, `/generate` returns HTTP 501
and King3D's **mock provider** is the supported path:

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

1. Install TRELLIS.2 via its `setup.sh`, **omitting the non-commercial NVIDIA
   render extras** for a commercial build:
   `. ./setup.sh --new-env --basic --flash-attn --o-voxel --cumesh --flexgemm`
   (add `--nvdiffrast --nvdiffrec` only for research/preview rendering). Swap the
   Docker base image for a CUDA 12.4 one; target a GPU with ≥24 GB VRAM.
2. Implement `_load_pipeline()` and the inference block in `app.py` (both are
   marked with the exact lines to fill in). Export GLB **with PBR** so the
   materials survive into King3D.
3. Point King3D at it: `KING3D_TRELLIS_MODE=http KING3D_TRELLIS_URL=http://<host>:8900`.

## API

### `GET /healthz`
`{ "ok": true, "model_id": "...", "model_loaded": false }`

### `POST /generate` (multipart)
Fields: `image` (file, optional), `prompt` (string, optional), `seed` (int,
optional). At least one of `image`/`prompt` is required. On success returns the
GLB bytes with `Content-Type: model/gltf-binary`.
