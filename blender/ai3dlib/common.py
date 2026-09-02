"""Shared bpy helpers.

Everything here is defensive about Blender API drift: enum identifiers and
operator locations have moved between 3.x, 4.x and 5.x, so we resolve them at
runtime from the RNA rather than hardcoding strings that silently stop matching.
"""

from __future__ import annotations

import math
import os
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import bpy
import mathutils

from .dispatch import CommandError

Vec3 = Tuple[float, float, float]


# --------------------------------------------------------------------------- paths


def abspath(ctx, path: str) -> str:
    """Resolve a possibly-relative path against the job working directory."""
    if not path:
        raise CommandError("BAD_PATH", "Empty path")
    if os.path.isabs(path):
        return os.path.normpath(path)
    base = getattr(ctx, "cwd", "") or os.getcwd()
    return os.path.normpath(os.path.join(base, path))


def ensure_parent_dir(path: str) -> str:
    parent = os.path.dirname(path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    return path


# --------------------------------------------------------------------------- objects


def get_object(name: str) -> bpy.types.Object:
    obj = bpy.data.objects.get(name)
    if obj is None:
        known = ", ".join(sorted(o.name for o in bpy.data.objects)[:20])
        raise CommandError("OBJECT_NOT_FOUND", "No object named '%s'. Present: %s" % (name, known or "(none)"))
    return obj


def get_mesh_object(name: str) -> bpy.types.Object:
    obj = get_object(name)
    if obj.type != "MESH":
        raise CommandError("NOT_A_MESH", "Object '%s' is a %s, not a MESH" % (name, obj.type))
    return obj


def mesh_objects(names: Sequence[str] = ()) -> List[bpy.types.Object]:
    """Named mesh objects, or every visible mesh when no names are given."""
    if names:
        return [get_mesh_object(n) for n in names]
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render]


def deselect_all() -> None:
    for obj in bpy.context.selected_objects:
        obj.select_set(False)
    bpy.context.view_layer.objects.active = None


def select_only(objects: Iterable[bpy.types.Object]) -> List[bpy.types.Object]:
    deselect_all()
    selected = []
    for obj in objects:
        obj.select_set(True)
        selected.append(obj)
    if selected:
        bpy.context.view_layer.objects.active = selected[0]
    return selected


def as_vec(value: Optional[Sequence[float]], default: Vec3 = (0.0, 0.0, 0.0)) -> Vec3:
    if value is None:
        return default
    if len(value) != 3:
        raise CommandError("BAD_VECTOR", "Expected 3 numbers, got %r" % (value,))
    return (float(value[0]), float(value[1]), float(value[2]))


def vec_out(value) -> List[float]:
    """Round for stable JSON: raw floats carry noise that breaks result diffing."""
    return [round(float(v), 6) for v in value]


# --------------------------------------------------------------------------- geometry


def triangle_count(obj: bpy.types.Object, evaluated: bool = True) -> int:
    """Triangle count after modifiers, which is what a renderer and an exporter see."""
    if obj.type != "MESH":
        return 0
    depsgraph = bpy.context.evaluated_depsgraph_get()
    source = obj.evaluated_get(depsgraph) if evaluated else obj
    try:
        mesh = source.to_mesh()
    except RuntimeError:
        return 0
    try:
        try:
            mesh.calc_loop_triangles()
        except AttributeError:
            pass  # auto-computed in newer builds
        return len(mesh.loop_triangles)
    finally:
        source.to_mesh_clear()


def scene_triangle_count() -> int:
    return sum(triangle_count(o) for o in bpy.context.scene.objects if o.type == "MESH")


def world_bbox(objects: Sequence[bpy.types.Object]) -> Tuple[Vec3, Vec3]:
    """Axis-aligned world-space bounds of the given objects."""
    if not objects:
        raise CommandError("EMPTY_SELECTION", "No objects to measure")
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    for obj in objects:
        matrix = obj.matrix_world
        for corner in obj.bound_box:
            point = matrix @ mathutils.Vector(corner)
            for axis in range(3):
                lo[axis] = min(lo[axis], point[axis])
                hi[axis] = max(hi[axis], point[axis])
    if not all(math.isfinite(v) for v in lo + hi):
        raise CommandError("EMPTY_SELECTION", "Objects have no measurable bounds")
    return (lo[0], lo[1], lo[2]), (hi[0], hi[1], hi[2])


def look_at_euler(location: Sequence[float], target: Sequence[float]) -> Vec3:
    """Euler rotation aiming -Z at target with +Y up, the Blender camera convention."""
    direction = mathutils.Vector(target) - mathutils.Vector(location)
    if direction.length == 0:
        return (0.0, 0.0, 0.0)
    quat = direction.to_track_quat("-Z", "Y")
    euler = quat.to_euler()
    return (euler.x, euler.y, euler.z)


def set_dimensions(obj: bpy.types.Object, dimensions: Vec3) -> None:
    """Scale an object so its local bounding box matches the requested size."""
    current = obj.dimensions
    factors = []
    for axis in range(3):
        want = float(dimensions[axis])
        have = float(current[axis])
        factors.append(want / have if have > 1e-9 else 1.0)
    obj.scale = (obj.scale[0] * factors[0], obj.scale[1] * factors[1], obj.scale[2] * factors[2])
    bpy.context.view_layer.update()


# --------------------------------------------------------------------------- render engine


_ENGINE_PREFERENCES = {
    # Requested kind -> candidate RNA identifiers, newest naming first.
    "EEVEE": ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"),
    "CYCLES": ("CYCLES",),
    "WORKBENCH": ("BLENDER_WORKBENCH",),
}


def available_engines() -> List[str]:
    """Built-in engines only.

    Engines that ship as addons (Cycles) never appear here even when usable, so
    this is for diagnostics; assignment is what actually decides availability.
    """
    prop = bpy.types.RenderSettings.bl_rna.properties["engine"]
    return [item.identifier for item in prop.enum_items]


def ensure_cycles_addon() -> bool:
    """Cycles is an addon, and --factory-startup starts with addons disabled."""
    try:
        import addon_utils

        loaded_default, loaded_state = addon_utils.check("cycles")
        if loaded_state:
            return True
        addon_utils.enable("cycles", default_set=False, persistent=False)
        return addon_utils.check("cycles")[1]
    except Exception:  # noqa: BLE001 - absence is reported by the assignment below
        return False


def _configure_workbench(scene: bpy.types.Scene, samples: int) -> None:
    """Solid-mode shading that still shows per-material colour.

    Workbench is the only engine fast enough for iteration on a machine without a
    usable GPU, so it has to carry the structural review passes.
    """
    shading = scene.display.shading
    apply_setting(shading, "light", "STUDIO")
    apply_setting(shading, "color_type", "MATERIAL")
    apply_setting(shading, "show_shadows", True)
    apply_setting(shading, "show_cavity", True)
    apply_setting(shading, "show_object_outline", False)
    apply_setting(scene.display, "render_aa", "8" if samples >= 8 else "5")


def set_render_engine(scene: bpy.types.Scene, kind: str, samples: int) -> str:
    """Select an engine by trying its known identifiers and keeping the one that sticks.

    Introspecting the engine enum is not sufficient: addon-provided engines are
    absent from it, so the only reliable test is assignment.
    """
    kind = kind.upper()
    if kind == "CYCLES":
        ensure_cycles_addon()

    attempted = []
    for candidate in _ENGINE_PREFERENCES.get(kind, (kind,)):
        attempted.append(candidate)
        try:
            scene.render.engine = candidate
        except (TypeError, ValueError):
            continue

        engine = scene.render.engine
        if engine.startswith("BLENDER_EEVEE"):
            apply_setting(scene.eevee, "taa_render_samples", max(1, int(samples)))
        elif engine == "CYCLES":
            apply_setting(scene.cycles, "samples", max(1, int(samples)))
            apply_setting(scene.cycles, "device", "CPU")
            apply_setting(scene.cycles, "use_denoising", True)
        elif engine == "BLENDER_WORKBENCH":
            _configure_workbench(scene, int(samples))
        return engine

    raise CommandError(
        "ENGINE_UNAVAILABLE",
        "Could not select render engine '%s' (tried %s). Built-in engines: %s"
        % (kind, ", ".join(attempted), ", ".join(available_engines())),
    )


# --------------------------------------------------------------------------- misc


def apply_setting(target: Any, key: str, value: Any) -> bool:
    """Best-effort attribute assignment used for modifier settings."""
    if not hasattr(target, key):
        return False
    try:
        if isinstance(value, (list, tuple)) and len(value) == 3:
            setattr(target, key, tuple(float(v) for v in value))
        else:
            setattr(target, key, value)
        return True
    except (TypeError, ValueError, AttributeError):
        return False


def summarize_object(obj: bpy.types.Object) -> Dict[str, Any]:
    collection = obj.users_collection[0].name if obj.users_collection else None
    return {
        "name": obj.name,
        "type": obj.type,
        "location": vec_out(obj.location),
        "rotation_euler": vec_out(obj.rotation_euler),
        "scale": vec_out(obj.scale),
        "dimensions": vec_out(obj.dimensions),
        "tris": triangle_count(obj) if obj.type == "MESH" else 0,
        "materials": [m.name for m in obj.data.materials if m] if hasattr(obj.data, "materials") else [],
        "parent": obj.parent.name if obj.parent else None,
        "collection": collection,
        "visible": not obj.hide_render,
    }
