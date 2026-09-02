"""glTF export and re-import.

The export gate re-imports what was just written into a clean scene and compares
counts, because a glTF exporter reporting success is not proof the file loads.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List

import bpy

from . import common
from .dispatch import CommandError, Context, command


def _gltf_export_operator():
    """The gltf exporter has lived under different operator names across versions."""
    for group, name in (("export_scene", "gltf"), ("wm", "gltf_export")):
        namespace = getattr(bpy.ops, group, None)
        if namespace is not None and hasattr(namespace, name):
            return getattr(namespace, name)
    raise CommandError("EXPORTER_MISSING", "No glTF export operator found in this Blender build")


def _gltf_import_operator():
    for group, name in (("import_scene", "gltf"), ("wm", "gltf_import")):
        namespace = getattr(bpy.ops, group, None)
        if namespace is not None and hasattr(namespace, name):
            return getattr(namespace, name)
    raise CommandError("IMPORTER_MISSING", "No glTF import operator found in this Blender build")


@command("export.glb")
def export_glb(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    output = common.ensure_parent_dir(common.abspath(ctx, params["output"]))
    names: List[str] = params.get("objects") or []
    objects = common.mesh_objects(names)
    if not objects:
        raise CommandError("EMPTY_SELECTION", "Nothing to export: the scene has no visible mesh")

    common.select_only(objects)
    operator = _gltf_export_operator()

    kwargs = {
        "filepath": output,
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": bool(params.get("apply_modifiers", True)),
        "export_yup": bool(params.get("y_up", True)),
    }
    try:
        operator(**kwargs)
    except TypeError:
        # Older/newer builds drop or rename optional kwargs; retry with the core set.
        ctx.log("gltf exporter rejected optional kwargs; retrying with defaults")
        operator(filepath=output, export_format="GLB", use_selection=True)

    if not os.path.isfile(output):
        raise CommandError("EXPORT_NO_OUTPUT", "Exporter reported success but wrote no file at %s" % output)

    return {
        "output": output,
        "size_bytes": os.path.getsize(output),
        "exported": [obj.name for obj in objects],
    }


@command("import.glb")
def import_glb(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    path = common.abspath(ctx, params["path"])
    if not os.path.isfile(path):
        raise CommandError("FILE_NOT_FOUND", "No file at %s" % path)

    if params.get("reset_scene", True):
        for obj in list(bpy.context.scene.objects):
            bpy.data.objects.remove(obj, do_unlink=True)

    before = {obj.name for obj in bpy.context.scene.objects}
    _gltf_import_operator()(filepath=path)
    bpy.context.view_layer.update()

    imported = [obj for obj in bpy.context.scene.objects if obj.name not in before]
    meshes = [obj for obj in imported if obj.type == "MESH"]
    return {
        "objects": [obj.name for obj in meshes],
        "total_tris": sum(common.triangle_count(obj) for obj in meshes),
    }
