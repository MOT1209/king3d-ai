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

## ⛔ Step 0 — Licence review (blocking)

**Do not enable the model, download weights, or ship this commercially until the
TRELLIS.2 licence is confirmed to permit the intended use.** The user who owns
King3D is currently **unsure** of the licence terms, and King3D is an open-source
project — getting this wrong is a legal and distribution risk, not a technical
one.

Checklist before un-stubbing `app.py::_load_pipeline`:

- [ ] Read the LICENSE in `microsoft/TRELLIS.2` **and** the model-weights licence
      (code licence and weights licence are often different).
- [ ] Confirm whether commercial use is permitted, or research-only.
- [ ] Confirm redistribution terms for the weights (can they be baked into an
      image / cached in the cloud?).
- [ ] Record the resolved licence and the intended use (commercial / research)
      below, with a date and who confirmed it.
- [ ] Confirm the VRAM requirement of the 4B variant against your target GPU
      (this is **unverified** — do not assume a number).

Resolved licence: _(fill in)_
Intended use: _(fill in)_
Confirmed by / date: _(fill in)_

Until this is done, `/generate` returns HTTP 501 and King3D's **mock provider**
is the supported path:

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

1. Add torch + CUDA + `trellis2` to `requirements.txt` (pin to match your GPU and
   the TRELLIS.2 install guide) and swap the Docker base image for a CUDA one.
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
