"""Material creation and assignment via the Principled BSDF."""

from __future__ import annotations

from typing import Any, Dict, Optional

import bpy

from . import common
from .dispatch import CommandError, Context, command

# Socket names drift across versions (Emission -> Emission Color in 4.x), so each
# logical channel lists the names it has been known by.
_SOCKET_ALIASES = {
    "base_color": ("Base Color",),
    "metallic": ("Metallic",),
    "roughness": ("Roughness",),
    "ior": ("IOR",),
    "alpha": ("Alpha",),
    "emission_color": ("Emission Color", "Emission"),
    "emission_strength": ("Emission Strength",),
}


def _principled(material: bpy.types.Material) -> bpy.types.Node:
    node = material.node_tree.nodes.get("Principled BSDF")
    if node is not None:
        return node
    for candidate in material.node_tree.nodes:
        if candidate.type == "BSDF_PRINCIPLED":
            return candidate
    raise CommandError("NO_PRINCIPLED_BSDF", "Material '%s' has no Principled BSDF node" % material.name)


def _set_socket(node: bpy.types.Node, channel: str, value: Any, ctx: Context) -> bool:
    for socket_name in _SOCKET_ALIASES[channel]:
        socket = node.inputs.get(socket_name)
        if socket is None:
            continue
        try:
            socket.default_value = value
            return True
        except (TypeError, ValueError):
            # Colour sockets want 4 components even when the caller sent 3.
            if isinstance(value, (list, tuple)) and len(value) == 3:
                socket.default_value = (value[0], value[1], value[2], 1.0)
                return True
            raise
    ctx.log("material channel '%s' not present in this Blender build" % channel)
    return False


def build_material(spec: Dict[str, Any], ctx: Context) -> bpy.types.Material:
    """Create or update a material from a MaterialSpec dict."""
    name = spec.get("name")
    if not name:
        raise CommandError("MISSING_NAME", "Material spec requires a name")

    material = bpy.data.materials.get(name)
    if material is None:
        material = bpy.data.materials.new(name=name)
    material.use_nodes = True
    node = _principled(material)

    base_color = spec.get("base_color", [0.8, 0.8, 0.8, 1.0])
    if len(base_color) == 3:
        base_color = list(base_color) + [1.0]
    _set_socket(node, "base_color", tuple(float(c) for c in base_color), ctx)
    _set_socket(node, "metallic", float(spec.get("metallic", 0.0)), ctx)
    _set_socket(node, "roughness", float(spec.get("roughness", 0.5)), ctx)

    if spec.get("ior") is not None:
        _set_socket(node, "ior", float(spec["ior"]), ctx)

    alpha: Optional[float] = spec.get("alpha")
    if alpha is not None:
        _set_socket(node, "alpha", float(alpha), ctx)
        if alpha < 1.0:
            # Without this the surface renders opaque no matter the alpha value.
            common.apply_setting(material, "blend_method", "BLEND")

    if spec.get("emission_color") is not None:
        emission = list(spec["emission_color"])
        _set_socket(node, "emission_color", tuple(float(c) for c in emission) + (1.0,), ctx)
    if spec.get("emission_strength") is not None:
        _set_socket(node, "emission_strength", float(spec["emission_strength"]), ctx)

    return material


@command("material.assign")
def material_assign(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    obj = common.get_mesh_object(params["object"])
    material = build_material(params["material"], ctx)
    slot = int(params.get("slot", 0))

    slots = obj.data.materials
    while len(slots) <= slot:
        slots.append(None)
    slots[slot] = material

    return {"name": obj.name, "material": material.name, "slot": slot}
