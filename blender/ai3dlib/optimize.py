"""Game-ready optimisation: polygon budget and UV unwrapping."""

from __future__ import annotations

import math
from typing import Any, Dict, List

import bpy

from . import common
from .dispatch import CommandError, Context, command


@command("optimize.decimate")
def optimize_decimate(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    """Bring the selection under a triangle budget with a single collapse pass.

    The ratio is computed from the measured total rather than applied per object,
    so a budget stays a budget no matter how the model is split up.
    """
    objects = common.mesh_objects(params.get("objects") or [])
    if not objects:
        raise CommandError("EMPTY_SELECTION", "No mesh objects to optimise")

    target = int(params["target_tris"])
    min_ratio = float(params.get("min_ratio", 0.1))
    before = sum(common.triangle_count(obj) for obj in objects)

    if before <= target:
        ctx.log("already within budget: %d <= %d tris" % (before, target))
        return {"before_tris": before, "after_tris": before, "ratio": 1.0}

    ratio = max(min_ratio, target / float(before))
    for obj in objects:
        modifier = obj.modifiers.new(name="ai3d_decimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        common.select_only([obj])
        bpy.ops.object.modifier_apply(modifier=modifier.name)

    bpy.context.view_layer.update()
    after = sum(common.triangle_count(obj) for obj in objects)
    ctx.log("decimated %d -> %d tris (ratio %.3f)" % (before, after, ratio))
    return {"before_tris": before, "after_tris": after, "ratio": round(ratio, 6)}


@command("uv.unwrap")
def uv_unwrap(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    objects = common.mesh_objects(params.get("objects") or [])
    if not objects:
        raise CommandError("EMPTY_SELECTION", "No mesh objects to unwrap")

    method = params.get("method", "SMART")
    angle_limit = math.radians(float(params.get("angle_limit", 66.0)))
    island_margin = float(params.get("island_margin", 0.02))

    unwrapped: List[str] = []
    for obj in objects:
        common.select_only([obj])
        bpy.ops.object.mode_set(mode="EDIT")
        try:
            bpy.ops.mesh.select_all(action="SELECT")
            if method == "SMART":
                bpy.ops.uv.smart_project(angle_limit=angle_limit, island_margin=island_margin)
            else:
                bpy.ops.uv.unwrap(method="ANGLE_BASED", margin=island_margin)
        finally:
            bpy.ops.object.mode_set(mode="OBJECT")
        unwrapped.append(obj.name)

    return {"unwrapped": unwrapped}
