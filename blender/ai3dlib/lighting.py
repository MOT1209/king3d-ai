"""Light creation."""

from __future__ import annotations

from typing import Any, Dict

import bpy

from . import common
from .dispatch import Context, command


@command("light.create")
def light_create(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    name = params["name"]
    light_type = params.get("type", "AREA")
    location = common.as_vec(params["location"])

    existing = bpy.data.objects.get(name)
    if existing is not None:
        bpy.data.objects.remove(existing, do_unlink=True)

    data = bpy.data.lights.new(name=name + "_data", type=light_type)
    data.energy = float(params.get("energy", 100.0))
    color = common.as_vec(params.get("color"), (1.0, 1.0, 1.0))
    data.color = color

    if params.get("size") is not None:
        common.apply_setting(data, "size", float(params["size"]))
        common.apply_setting(data, "shadow_soft_size", float(params["size"]))
    if params.get("angle") is not None and light_type == "SUN":
        common.apply_setting(data, "angle", float(params["angle"]))

    obj = bpy.data.objects.new(name=name, object_data=data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location

    if params.get("look_at") is not None:
        obj.rotation_euler = common.look_at_euler(location, common.as_vec(params["look_at"]))
    elif params.get("rotation_euler") is not None:
        obj.rotation_euler = common.as_vec(params["rotation_euler"])

    bpy.context.view_layer.update()
    return {"name": obj.name}
