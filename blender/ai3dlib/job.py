"""Job execution shared by the one-shot runner and the persistent server.

A "job" is a batch of commands plus the scene context they run against. Keeping
this in one place means a batch behaves identically whether it arrived through a
file on disk or over a socket.
"""

from __future__ import annotations

import os
import time
import traceback
from typing import Any, Dict, Optional

from . import dispatch

_HANDLERS_LOADED = False


def ensure_handlers() -> None:
    global _HANDLERS_LOADED
    if not _HANDLERS_LOADED:
        dispatch.load_handlers()
        _HANDLERS_LOADED = True


class SceneOpenError(Exception):
    pass


def prepare_scene(load_blend: Optional[str], cwd: str = "") -> None:
    """Open the job's .blend, or start from a genuinely empty scene.

    A requested-but-missing file is an error, not a reason to silently hand back
    an empty scene: that failure mode looks like "the model came out empty".
    """
    import bpy

    if load_blend:
        if not os.path.isabs(load_blend):
            load_blend = os.path.normpath(os.path.join(cwd or os.getcwd(), load_blend))
        if not os.path.isfile(load_blend):
            raise SceneOpenError("load_blend does not exist: %s" % load_blend)
        bpy.ops.wm.open_mainfile(filepath=load_blend)
        # A saved file remembers its render engine. Reloading one saved with a
        # GPU engine can stall for minutes on a machine with no usable GPU, so
        # drop to the cheapest engine until a render command asks otherwise.
        try:
            bpy.context.scene.render.engine = "BLENDER_WORKBENCH"
        except (TypeError, ValueError):
            pass
    else:
        # --factory-startup still ships the default cube/camera/light.
        bpy.ops.wm.read_factory_settings(use_empty=True)


def run_job(job: Dict[str, Any], script_start: Optional[float] = None) -> Dict[str, Any]:
    """Execute a job dict and return the result payload."""
    import bpy

    started = script_start if script_start is not None else time.time()
    context_spec = job.get("context") or {}
    options = job.get("options") or {}

    t_loaded = time.time()
    try:
        prepare_scene(context_spec.get("load_blend"), context_spec.get("cwd") or os.getcwd())
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "responses": [],
            "fatal": {
                "code": "SCENE_OPEN_FAILED",
                "message": "%s: %s" % (type(exc).__name__, exc),
                "traceback": traceback.format_exc(limit=12),
            },
        }
    t_scene_ready = time.time()

    ensure_handlers()
    t_handlers_ready = time.time()

    ctx = dispatch.Context(
        cwd=context_spec.get("cwd") or os.getcwd(),
        allow_python_exec=bool(options.get("allow_python_exec", False)),
    )
    responses = dispatch.execute_batch(job.get("commands") or [], ctx)
    ok = all(response.get("ok") for response in responses)
    t_batch_done = time.time()

    saved_blend = None
    save_blend = context_spec.get("save_blend")
    if save_blend and ok:
        directory = os.path.dirname(save_blend)
        if directory and not os.path.isdir(directory):
            os.makedirs(directory, exist_ok=True)
        bpy.ops.wm.save_as_mainfile(filepath=save_blend, check_existing=False)
        saved_blend = save_blend

    versions = dispatch.runtime_versions()
    return {
        "ok": ok,
        "responses": responses,
        "blender_version": versions["blender_version"],
        "python_version": versions["python_version"],
        "saved_blend": saved_blend,
        "timings": {
            "job_read_ms": int((t_loaded - started) * 1000),
            "scene_open_ms": int((t_scene_ready - t_loaded) * 1000),
            "handlers_import_ms": int((t_handlers_ready - t_scene_ready) * 1000),
            "batch_ms": int((t_batch_done - t_handlers_ready) * 1000),
            "save_ms": int((time.time() - t_batch_done) * 1000),
        },
    }
