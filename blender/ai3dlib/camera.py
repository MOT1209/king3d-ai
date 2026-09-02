"""Camera placement, including automatic framing of a target bounding sphere."""

from __future__ import annotations

import math
from typing import Any, Dict, List, Sequence, Tuple

import bpy

from . import common
from .dispatch import Context, command

# Azimuth is measured around +Z starting at the Blender front view (camera on -Y).
STANDARD_VIEWS: Dict[str, Tuple[float, float]] = {
    "front": (0.0, 0.0),
    "back": (180.0, 0.0),
    "right": (90.0, 0.0),
    "left": (-90.0, 0.0),
    # Not exactly 90: at the pole the up-vector is ambiguous and the roll flips.
    "top": (0.0, 89.0),
    "three_quarter": (35.0, 20.0),
}


def ensure_camera(name: str) -> bpy.types.Object:
    obj = bpy.data.objects.get(name)
    if obj is not None and obj.type != "CAMERA":
        raise ValueError("object '%s' exists but is not a camera" % name)
    if obj is None:
        data = bpy.data.cameras.new(name + "_data")
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
    return obj


def orbit_position(center: Sequence[float], distance: float, azimuth_deg: float, elevation_deg: float):
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    return (
        center[0] + distance * math.sin(az) * math.cos(el),
        center[1] - distance * math.cos(az) * math.cos(el),
        center[2] + distance * math.sin(el),
    )


def fit_distance(radius: float, lens: float, sensor_width: float, res_x: int, res_y: int, margin: float) -> float:
    """Distance at which a sphere of `radius` fills the frame with `margin` slack."""
    radius = max(radius, 1e-4)
    sensor_height = sensor_width * (res_y / res_x) if res_x else sensor_width
    half_fov_x = math.atan((sensor_width * 0.5) / lens)
    half_fov_y = math.atan((sensor_height * 0.5) / lens)
    half_fov = max(min(half_fov_x, half_fov_y), 1e-3)
    return (radius * margin) / math.sin(half_fov)


def bounding_sphere(objects) -> Tuple[Tuple[float, float, float], float]:
    lo, hi = common.world_bbox(objects)
    center = tuple((lo[i] + hi[i]) * 0.5 for i in range(3))
    radius = 0.5 * math.sqrt(sum((hi[i] - lo[i]) ** 2 for i in range(3)))
    return center, max(radius, 1e-4)


def place_framed_camera(
    name: str,
    targets: Sequence[str],
    azimuth: float,
    elevation: float,
    margin: float,
    lens: float,
    make_active: bool = True,
) -> Dict[str, Any]:
    objects = common.mesh_objects(list(targets))
    center, radius = bounding_sphere(objects)

    scene = bpy.context.scene
    camera = ensure_camera(name)
    camera.data.lens = lens
    camera.data.sensor_width = 36.0
    camera.data.type = "PERSP"

    distance = fit_distance(
        radius, lens, camera.data.sensor_width, scene.render.resolution_x, scene.render.resolution_y, margin
    )
    location = orbit_position(center, distance, azimuth, elevation)
    camera.location = location
    camera.rotation_euler = common.look_at_euler(location, center)
    # Keep the whole object between the clip planes regardless of scene scale.
    camera.data.clip_start = max(distance * 0.01, 0.001)
    camera.data.clip_end = distance * 10.0

    if make_active:
        scene.camera = camera
    bpy.context.view_layer.update()

    return {
        "name": camera.name,
        "location": common.vec_out(location),
        "distance": round(distance, 6),
    }


@command("camera.set")
def camera_set(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    name = params.get("name", "Camera")
    location = common.as_vec(params["location"])
    camera = ensure_camera(name)
    camera.location = location
    camera.data.lens = float(params.get("lens", 50.0))
    camera.data.sensor_width = float(params.get("sensor_width", 36.0))
    camera.data.type = params.get("type", "PERSP")
    if params.get("ortho_scale") is not None:
        camera.data.ortho_scale = float(params["ortho_scale"])

    if params.get("look_at") is not None:
        camera.rotation_euler = common.look_at_euler(location, common.as_vec(params["look_at"]))
    elif params.get("rotation_euler") is not None:
        camera.rotation_euler = common.as_vec(params["rotation_euler"])

    if params.get("make_active", True):
        bpy.context.scene.camera = camera
    bpy.context.view_layer.update()
    return {"name": camera.name}


@command("camera.frame")
def camera_frame(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    return place_framed_camera(
        name=params.get("name", "Camera"),
        targets=params.get("targets") or [],
        azimuth=float(params.get("azimuth", 35.0)),
        elevation=float(params.get("elevation", 20.0)),
        margin=float(params.get("margin", 1.15)),
        lens=float(params.get("lens", 50.0)),
        make_active=bool(params.get("make_active", True)),
    )
