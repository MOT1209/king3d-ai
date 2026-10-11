# -*- coding: utf-8 -*-
"""TRELLIS.2 inference microservice for King3D generative mode.

This is the Python/CUDA "generative brain": it turns an image or prompt into a
raw base mesh (GLB, ideally with PBR materials), which the King3D Node pipeline
then imports, repairs and makes game-ready. The boundary is deliberately HTTP so
nothing CUDA-specific leaks into the Node core or the Blender bridge, and the
same service runs locally or in the cloud - only the URL King3D points at changes
(KING3D_TRELLIS_URL).

STATUS: skeleton. The actual TRELLIS.2 model is NOT wired in yet. Wiring it is
blocked on the licence review in README.md (step 0 of the integration plan): do
not uncomment the model import or distribute weights until that is resolved.
Until then every /generate call returns HTTP 501 with an explanatory message,
and King3D's mock provider (KING3D_TRELLIS_MODE=mock) is the GPU-free path for
development and CI.

Run (after installing requirements and wiring the model):
    uvicorn app:app --host 0.0.0.0 --port 8900
"""
from __future__ import annotations

import io
import os

from fastapi import FastAPI, Form, UploadFile
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="king3d-trellis", version="0.1.0")

# The 4B pipeline is heavy to load, so it is created once on first use and reused.
_PIPELINE = None
_MODEL_ID = os.environ.get("TRELLIS_MODEL_ID", "microsoft/TRELLIS.2")


def _load_pipeline():
    """Load the TRELLIS.2 pipeline once.

    Left unimplemented on purpose until the model is wired in. When enabling,
    import ONLY the generation pipeline - do NOT import o_voxel.postprocess
    (its module-level `import nvdiffrast` pulls in the non-commercial NVIDIA
    rasterizer; see README Step 0). For a commercial build King3D uses the
    geometry-only export below, which never touches nvdiffrast:

        from trellis2.pipelines import Trellis2ImageTo3DPipeline
        pipe = Trellis2ImageTo3DPipeline.from_pretrained(_MODEL_ID)
        pipe.cuda()
        return pipe
    """
    raise NotImplementedError(
        "TRELLIS.2 model is not wired in yet - see services/trellis/README.md. "
        "Use KING3D_TRELLIS_MODE=mock for a GPU-free run in the meantime."
    )


def _pipeline():
    global _PIPELINE
    if _PIPELINE is None:
        _PIPELINE = _load_pipeline()
    return _PIPELINE


@app.get("/healthz")
def healthz() -> JSONResponse:
    """Liveness + whether the model has been loaded. Never loads the model."""
    return JSONResponse({"ok": True, "model_id": _MODEL_ID, "model_loaded": _PIPELINE is not None})


@app.post("/generate")
async def generate(
    image: UploadFile | None = None,
    prompt: str | None = Form(default=None),
    seed: int = Form(default=0),
) -> Response:
    """Generate a base mesh from an image and/or prompt; return GLB bytes.

    The King3D client (src/integrations/trellis/client.ts) POSTs multipart with
    an optional `image` file and optional `prompt`/`seed` fields, and expects the
    response body to be the GLB (Content-Type: model/gltf-binary).
    """
    if image is None and not prompt:
        return JSONResponse({"error": "image or prompt required"}, status_code=400)

    try:
        pipe = _pipeline()
    except NotImplementedError as exc:
        return JSONResponse({"error": str(exc)}, status_code=501)

    image_bytes = await image.read() if image is not None else None

    # --- wire the real inference here once the model is enabled ---------------
    # GEOMETRY-ONLY export (commercial-safe: no nvdiffrast). King3D supplies the
    # material and UVs, so we export only vertices+faces via trimesh and never
    # call o_voxel.postprocess.to_glb (which rasterizes the texture with the
    # non-commercial NVIDIA nvdiffrast). See README Step 0, option 3.
    #
    #   from PIL import Image as _Image
    #   mesh = pipe.run(_Image.open(io.BytesIO(image_bytes)))[0]   # seed=seed if supported
    #   import trimesh
    #   tm = trimesh.Trimesh(
    #       vertices=mesh.vertices.detach().cpu().numpy(),
    #       faces=mesh.faces.detach().cpu().numpy(),
    #       process=False,
    #   )
    #   buf = io.BytesIO()
    #   tm.export(buf, file_type="glb")   # geometry only; no textures/materials
    #   return Response(content=buf.getvalue(), media_type="model/gltf-binary")
    #
    # (Exact attribute access, e.g. mesh.vertices/mesh.faces, must be confirmed
    # against the installed trellis2 version. For a RESEARCH build wanting
    # TRELLIS's baked PBR, install nvdiffrast and use o_voxel.postprocess.to_glb
    # instead - but that is NON-COMMERCIAL.)
    _ = (pipe, image_bytes, prompt, seed, io)  # referenced so linters stay quiet
    return JSONResponse({"error": "inference not implemented"}, status_code=501)
