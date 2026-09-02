"""Object creation and editing: primitives, transforms, modifiers, booleans, joins."""

from __future__ import annotations

from typing import Any, Callable, Dict

import bpy

from . import common
from .dispatch import CommandError, Context, command

# Primitive kind -> (operator, allowed option kwargs). Options are filtered so a
# caller cannot smuggle arbitrary kwargs into a bpy operator.
_PRIMITIVES: Dict[str, tuple] = {
    "cube": (bpy.ops.mesh.primitive_cube_add, {"size"}),
    "uv_sphere": (bpy.ops.mesh.primitive_uv_sphere_add, {"radius", "segments", "ring_count"}),
    "ico_sphere": (bpy.ops.mesh.primitive_ico_sphere_add, {"radius", "subdivisions"}),
    "cylinder": (bpy.ops.mesh.primitive_cylinder_add, {"radius", "depth", "vertices", "end_fill_type"}),
    "cone": (bpy.ops.mesh.primitive_cone_add, {"radius1", "radius2", "depth", "vertices"}),
    "torus": (bpy.ops.mesh.primitive_torus_add, {"major_radius", "minor_radius", "major_segments", "minor_segments"}),
    "plane": (bpy.ops.mesh.primitive_plane_add, {"size"}),
    "circle": (bpy.ops.mesh.primitive_circle_add, {"radius", "vertices", "fill_type"}),
    "empty": (None, set()),
}


def _link_to_collection(obj: bpy.types.Object, collection_name: str) -> None:
    collection = bpy.data.collections.get(collection_name)
    if collection is None:
        collection = bpy.data.collections.new(collection_name)
        bpy.context.scene.collection.children.link(collection)
    for existing in list(obj.users_collection):
        existing.objects.unlink(obj)
    collection.objects.link(obj)


@command("object.create")
def object_create(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    kind = params.get("kind")
    name = params.get("name")
    if kind not in _PRIMITIVES:
        raise CommandError("UNKNOWN_PRIMITIVE", "Unsupported primitive '%s'" % kind)
    if not name:
        raise CommandError("MISSING_NAME", "object.create requires a name")
    if bpy.data.objects.get(name) is not None:
        raise CommandError("NAME_TAKEN", "An object named '%s' already exists" % name)

    location = common.as_vec(params.get("location"))
    rotation = common.as_vec(params.get("rotation_euler"))
    scale = common.as_vec(params.get("scale"), (1.0, 1.0, 1.0))
    options = params.get("options") or {}

    operator, allowed = _PRIMITIVES[kind]
    common.deselect_all()

    if kind == "empty":
        obj = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = location
    else:
        kwargs = {k: v for k, v in options.items() if k in allowed}
        rejected = sorted(set(options) - allowed)
        if rejected:
            ctx.log("ignored options for %s: %s" % (kind, ", ".join(rejected)))
        operator(location=location, rotation=rotation, **kwargs)
        obj = bpy.context.active_object
        if obj is None:
            raise CommandError("CREATE_FAILED", "Blender did not produce an object for '%s'" % kind)
        obj.name = name
        if obj.data is not None:
            obj.data.name = name + "_mesh"

    obj.rotation_euler = rotation
    obj.scale = scale
    bpy.context.view_layer.update()

    dimensions = params.get("dimensions")
    if dimensions and obj.type == "MESH":
        common.set_dimensions(obj, common.as_vec(dimensions))

    parent_name = params.get("parent")
    if parent_name:
        parent = common.get_object(parent_name)
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()

    collection_name = params.get("collection")
    if collection_name:
        _link_to_collection(obj, collection_name)

    if params.get("shade_smooth") and obj.type == "MESH":
        for polygon in obj.data.polygons:
            polygon.use_smooth = True

    bpy.context.view_layer.update()
    return {"name": obj.name, "dimensions": common.vec_out(obj.dimensions)}


@command("object.transform")
def object_transform(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    obj = common.get_object(params["name"])

    if params.get("location") is not None:
        obj.location = common.as_vec(params["location"])
    if params.get("delta_location") is not None:
        delta = common.as_vec(params["delta_location"])
        obj.location = (obj.location[0] + delta[0], obj.location[1] + delta[1], obj.location[2] + delta[2])
    if params.get("rotation_euler") is not None:
        obj.rotation_euler = common.as_vec(params["rotation_euler"])
    if params.get("scale") is not None:
        obj.scale = common.as_vec(params["scale"], (1.0, 1.0, 1.0))
    bpy.context.view_layer.update()

    origin_to = params.get("origin_to")
    if origin_to:
        common.select_only([obj])
        mapping = {"geometry": "ORIGIN_GEOMETRY", "bounds": "ORIGIN_GEOMETRY", "world": "ORIGIN_CURSOR"}
        center = "BOUNDS" if origin_to == "bounds" else "MEDIAN"
        if origin_to == "world":
            bpy.context.scene.cursor.location = (0.0, 0.0, 0.0)
        bpy.ops.object.origin_set(type=mapping[origin_to], center=center)

    if params.get("apply"):
        common.select_only([obj])
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    bpy.context.view_layer.update()
    return {"name": obj.name, "dimensions": common.vec_out(obj.dimensions)}


@command("object.modifier")
def object_modifier(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    obj = common.get_mesh_object(params["object"])
    mod_type = params["type"]
    name = params.get("name") or mod_type.title()

    try:
        modifier = obj.modifiers.new(name=name, type=mod_type)
    except (TypeError, RuntimeError) as exc:
        raise CommandError("MODIFIER_UNSUPPORTED", "Cannot add %s modifier: %s" % (mod_type, exc))

    unknown = []
    for key, value in (params.get("settings") or {}).items():
        if not common.apply_setting(modifier, key, value):
            unknown.append(key)
    if unknown:
        ctx.log("ignored %s settings: %s" % (mod_type, ", ".join(sorted(unknown))))

    applied = False
    if params.get("apply"):
        common.select_only([obj])
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        applied = True

    bpy.context.view_layer.update()
    return {"name": obj.name, "applied": applied}


@command("object.boolean")
def object_boolean(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    obj = common.get_mesh_object(params["object"])
    cutter = common.get_mesh_object(params["cutter"])
    operation = params.get("operation", "DIFFERENCE")

    modifier = obj.modifiers.new(name="ai3d_boolean", type="BOOLEAN")
    modifier.operation = operation
    modifier.object = cutter
    # EXACT keeps coplanar faces sane; FAST produces holes on thin geometry.
    common.apply_setting(modifier, "solver", "EXACT")

    applied = False
    if params.get("apply", True):
        common.select_only([obj])
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        applied = True
        if params.get("delete_cutter", True):
            bpy.data.objects.remove(cutter, do_unlink=True)

    bpy.context.view_layer.update()
    return {"name": obj.name, "applied": applied}


@command("object.join")
def object_join(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    names = params["objects"]
    into = params["into"]
    if into not in names:
        raise CommandError("JOIN_TARGET_MISSING", "'%s' must be one of the objects being joined" % into)

    target = common.get_mesh_object(into)
    others = [common.get_mesh_object(n) for n in names if n != into]

    common.deselect_all()
    for obj in others:
        obj.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()
    bpy.context.view_layer.update()
    return {"name": target.name}
