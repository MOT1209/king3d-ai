"""Mesh inspection - the measured facts the deterministic quality gates run on."""

from __future__ import annotations

import math
from typing import Any, Dict, List

import bmesh
import bpy

from . import common
from .dispatch import Context, command


def mesh_stats(obj: bpy.types.Object) -> Dict[str, Any]:
    mesh = obj.data
    bm = bmesh.new()
    try:
        bm.from_mesh(mesh)

        ngons = sum(1 for face in bm.faces if len(face.verts) > 4)
        non_manifold = sum(1 for edge in bm.edges if not edge.is_manifold)
        loose_verts = sum(1 for vert in bm.verts if not vert.link_edges)
        try:
            volume = abs(bm.calc_volume(signed=True))
        except Exception:  # noqa: BLE001 - open meshes have no well-defined volume
            volume = 0.0

        uv_layers = [layer.name for layer in mesh.uv_layers]
        slots = list(mesh.materials)

        scale = tuple(obj.scale)
        rotation = tuple(obj.rotation_euler)
        transform_applied = all(abs(s - 1.0) < 1e-4 for s in scale) and all(abs(r) < 1e-4 for r in rotation)

        bbox_min, bbox_max = common.world_bbox([obj])
        # obj.dimensions is the local bounding box times scale and ignores rotation,
        # so a rotated part reports misleading sizes. The gates compare against this
        # world-space extent instead.
        world_dimensions = tuple(bbox_max[i] - bbox_min[i] for i in range(3))

        return {
            "name": obj.name,
            "verts": len(bm.verts),
            "edges": len(bm.edges),
            "faces": len(bm.faces),
            "tris": common.triangle_count(obj),
            "ngons": ngons,
            "non_manifold_edges": non_manifold,
            "loose_verts": loose_verts,
            "has_uv": len(uv_layers) > 0,
            "uv_layers": uv_layers,
            "material_slots": len(slots),
            "empty_material_slots": sum(1 for m in slots if m is None),
            "dimensions": common.vec_out(obj.dimensions),
            "world_dimensions": common.vec_out(world_dimensions),
            "bbox_min": common.vec_out(bbox_min),
            "bbox_max": common.vec_out(bbox_max),
            "scale": common.vec_out(scale),
            "transform_applied": transform_applied,
            "volume": round(volume, 8) if math.isfinite(volume) else 0.0,
        }
    finally:
        bm.free()


@command("inspect.mesh")
def inspect_one(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    return mesh_stats(common.get_mesh_object(params["object"]))


@command("inspect.all")
def inspect_all(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    objects = common.mesh_objects(params.get("objects") or [])
    meshes: List[Dict[str, Any]] = [mesh_stats(obj) for obj in objects]
    return {"meshes": meshes}
