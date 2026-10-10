"""Geometry repair for imported meshes.

The procedural builder never produces broken topology, so the rest of ai3dlib
has no need to repair geometry. A mesh that arrives from outside - a glTF from a
generative model such as TRELLIS.2 - is the opposite case: dense marching-cubes
output with duplicated vertices, stray loose geometry, zero-area faces, open
holes and inconsistent normals. `repair.clean` is a best-effort pass that makes
such a mesh as close to watertight and manifold as standard bpy operators can,
before the existing decimate/UV/export stages run.

This is best-effort, not a guarantee: some generative meshes have topology that
no operator sequence can make fully manifold (true retopology is out of scope).
The handler therefore reports the residual non-manifold edge and loose vertex
counts so the generative integrity gate can judge what remains.
"""

from __future__ import annotations

from typing import Any, Dict, List

import bmesh
import bpy

from . import common
from .dispatch import CommandError, Context, command


def _residual_counts(obj: bpy.types.Object) -> Dict[str, int]:
    """Non-manifold edges and loose vertices left on a mesh after a repair pass."""
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        non_manifold = sum(1 for edge in bm.edges if not edge.is_manifold)
        loose = sum(1 for vert in bm.verts if not vert.link_edges)
        return {"non_manifold_edges": non_manifold, "loose_verts": loose}
    finally:
        bm.free()


@command("repair.clean")
def repair_clean(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    """Best-effort make-watertight pass on one or more imported meshes.

    Order matters: weld duplicated vertices first so later steps see a single
    coherent surface, drop loose geometry and degenerate faces, fill the holes
    that remain, then make normals consistent so the exporter and the renderer
    agree on which way each face points.
    """
    objects = common.mesh_objects(params.get("objects") or [])
    if not objects:
        raise CommandError("EMPTY_SELECTION", "No mesh objects to repair")

    weld = float(params.get("weld_distance_m", 0.0001))
    do_delete_loose = bool(params.get("delete_loose", True))
    do_dissolve = bool(params.get("dissolve_degenerate", True))
    do_fill = bool(params.get("fill_holes", True))
    do_recalc = bool(params.get("recalc_normals", True))

    cleaned: List[Dict[str, Any]] = []
    for obj in objects:
        common.select_only([obj])
        bpy.ops.object.mode_set(mode="EDIT")
        try:
            bpy.ops.mesh.select_all(action="SELECT")
            # Weld coincident vertices: generative meshes routinely carry seams of
            # duplicated verts that read as non-manifold until merged.
            bpy.ops.mesh.remove_doubles(threshold=weld)
            if do_delete_loose:
                # Verts/edges only; deleting stray faces can punch new holes.
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True, use_faces=False)
            if do_dissolve:
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.mesh.dissolve_degenerate(threshold=weld)
            if do_fill:
                bpy.ops.mesh.select_all(action="SELECT")
                # sides=0 fills holes of any size.
                bpy.ops.mesh.fill_holes(sides=0)
            if do_recalc:
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.mesh.normals_make_consistent(inside=False)
        finally:
            bpy.ops.object.mode_set(mode="OBJECT")

        bpy.context.view_layer.update()
        residual = _residual_counts(obj)
        ctx.log(
            "repaired %s: non_manifold_edges=%d loose_verts=%d"
            % (obj.name, residual["non_manifold_edges"], residual["loose_verts"])
        )
        cleaned.append({"name": obj.name, **residual})

    return {"cleaned": cleaned}
