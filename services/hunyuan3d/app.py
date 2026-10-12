# -*- coding: utf-8 -*-
"""Hunyuan3D inference service skeleton for King3D (OPTIONAL, user-supplied).

Same HTTP contract as services/trellis, so King3D's generic mesh-generator client
can call it: GET /healthz and POST /generate (multipart image/prompt/seed) -> GLB.

STATUS: skeleton. No Hunyuan3D code or weights are included or downloaded, and
/generate returns HTTP 501. Read README.md first: the Tencent Hunyuan 3D licence does
not apply in the EU, UK or South Korea, and also forbids using the OUTPUT there.
Only wire the model in if you are inside the licensed Territory and accept Tencent's
licence yourself.

Like the TRELLIS service, export GEOMETRY ONLY (vertices + faces via trimesh):
King3D assigns its own material and UVs, so no textured/baked output is needed.

Run:  uvicorn app:app --host 0.0.0.0 --port 8901
Then: KING3D_GEN_HUNYUAN3D_URL=http://127.0.0.1:8901
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Form, UploadFile
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="king3d-hunyuan3d", version="0.1.0")

_MODEL_ID = os.environ.get("HUNYUAN3D_MODEL_ID", "tencent/Hunyuan3D-2.1")


@app.get("/healthz")
def healthz() -> JSONResponse:
    return JSONResponse({"ok": True, "model_id": _MODEL_ID, "model_loaded": False})


@app.post("/generate")
async def generate(
    image: UploadFile | None = None,
    prompt: str | None = Form(default=None),
    seed: int = Form(default=0),
) -> Response:
    if image is None and not prompt:
        return JSONResponse({"error": "image or prompt required"}, status_code=400)
    _ = seed
    return JSONResponse(
        {
            "error": "Hunyuan3D is not wired in. See services/hunyuan3d/README.md "
            "(licence: excluded in the EU, UK and South Korea)."
        },
        status_code=501,
    )
