"""Rendering: single stills and the multi-view sets the review stage compares."""

from __future__ import annotations

import os
from typing import Any, Dict, List

import bpy

from . import camera as camera_mod
from . import common
from .dispatch import CommandError, Context, command


def _configure(scene: bpy.types.Scene, params: Dict[str, Any]) -> str:
    resolution = params.get("resolution", [800, 800])
    scene.render.resolution_x = int(resolution[0])
    scene.render.resolution_y = int(resolution[1])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = bool(params.get("film_transparent", False))
    return common.set_render_engine(scene, params.get("engine", "EEVEE"), int(params.get("samples", 32)))


@command("render.still")
def render_still(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    scene = bpy.context.scene
    engine = _configure(scene, params)

    camera_name = params.get("camera")
    if camera_name:
        scene.camera = common.get_object(camera_name)
    if scene.camera is None:
        raise CommandError("NO_CAMERA", "The scene has no active camera; call camera.frame or camera.set first")

    output = common.ensure_parent_dir(common.abspath(ctx, params["output"]))
    scene.render.filepath = output
    bpy.ops.render.render(write_still=True)

    if not os.path.isfile(output):
        raise CommandError("RENDER_NO_OUTPUT", "Blender reported success but wrote no file at %s" % output)

    return {
        "output": output,
        "engine": engine,
        "width": scene.render.resolution_x,
        "height": scene.render.resolution_y,
    }


@command("render.views")
def render_views(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    """Render the same subject from several standard angles with one camera.

    Framing is recomputed per view so a long object stays fully in frame from
    every side instead of being cropped by a single fixed distance.
    """
    scene = bpy.context.scene
    engine = _configure(scene, params)

    views: List[str] = params.get("views") or ["front", "right", "three_quarter", "top"]
    targets = params.get("targets") or []
    margin = float(params.get("margin", 1.15))
    out_dir = common.abspath(ctx, params["output_dir"])
    os.makedirs(out_dir, exist_ok=True)

    images = []
    for view in views:
        if view not in camera_mod.STANDARD_VIEWS:
            raise CommandError("UNKNOWN_VIEW", "Unknown view '%s'" % view)
        azimuth, elevation = camera_mod.STANDARD_VIEWS[view]
        camera_mod.place_framed_camera(
            name="ai3d_review_cam",
            targets=targets,
            azimuth=azimuth,
            elevation=elevation,
            margin=margin,
            lens=50.0,
            make_active=True,
        )
        path = os.path.join(out_dir, "%s.png" % view)
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        if not os.path.isfile(path):
            raise CommandError("RENDER_NO_OUTPUT", "View '%s' produced no file" % view)
        images.append({"view": view, "path": path})

    ctx.log("rendered %d views with %s" % (len(images), engine))
    return {"images": images}
