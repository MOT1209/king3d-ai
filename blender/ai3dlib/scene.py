"""Scene-level commands: ping, info, reset, delete, world."""

from __future__ import annotations

from typing import Any, Dict

import bpy

from . import common
from .dispatch import CommandError, Context, command, runtime_versions


@command("ping")
def ping(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    info = runtime_versions()
    info["pong"] = True
    return info


@command("scene.info")
def scene_info(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    scene = bpy.context.scene
    objects = [common.summarize_object(o) for o in scene.objects]
    versions = runtime_versions()

    orphan_meshes = sum(1 for m in bpy.data.meshes if m.users == 0)
    orphan_materials = sum(1 for m in bpy.data.materials if m.users == 0)

    return {
        "blender_version": versions["blender_version"],
        "python_version": versions["python_version"],
        "engine": scene.render.engine,
        "scene_name": scene.name,
        "objects": objects,
        "counts": {
            "objects": len(scene.objects),
            "meshes": sum(1 for o in scene.objects if o.type == "MESH"),
            "cameras": sum(1 for o in scene.objects if o.type == "CAMERA"),
            "lights": sum(1 for o in scene.objects if o.type == "LIGHT"),
            "materials": len(bpy.data.materials),
            "orphan_meshes": orphan_meshes,
            "orphan_materials": orphan_materials,
            "total_tris": sum(o["tris"] for o in objects),
        },
    }


@command("scene.reset")
def scene_reset(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    keep_camera = bool(params.get("keep_camera", False))
    keep_lights = bool(params.get("keep_lights", False))

    doomed = []
    for obj in list(bpy.context.scene.objects):
        if keep_camera and obj.type == "CAMERA":
            continue
        if keep_lights and obj.type == "LIGHT":
            continue
        doomed.append(obj)

    for obj in doomed:
        bpy.data.objects.remove(obj, do_unlink=True)

    # Purge the datablocks the removed objects were holding, so a reset scene
    # really is empty rather than merely emptied of object wrappers.
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.cameras, bpy.data.lights):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)

    ctx.log("reset removed %d objects" % len(doomed))
    return {"ok": True}


@command("object.delete")
def object_delete(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    names = params.get("names") or []
    deleted = []
    for name in names:
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        bpy.data.objects.remove(obj, do_unlink=True)
        deleted.append(name)
    return {"deleted": deleted}


@command("world.set")
def world_set(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    color = common.as_vec(params.get("color"), (0.05, 0.05, 0.05))
    strength = float(params.get("strength", 1.0))
    transparent = bool(params.get("transparent", False))

    scene = bpy.context.scene
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("World")
        scene.world = world

    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is None:
        for node in world.node_tree.nodes:
            if node.type == "BACKGROUND":
                background = node
                break
    if background is None:
        raise CommandError("WORLD_NODE_MISSING", "World node tree has no Background node")

    background.inputs["Color"].default_value = (color[0], color[1], color[2], 1.0)
    background.inputs["Strength"].default_value = strength
    scene.render.film_transparent = transparent
    return {"ok": True}
