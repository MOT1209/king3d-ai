"""Contact sheet compositing.

The review stage shows the model exactly one image: the reference beside the
renders, each cell captioned. Building it here (numpy is bundled with Blender)
keeps the whole pipeline free of pip dependencies.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Tuple

import bpy
import numpy as np

from . import common, font5x7
from .dispatch import CommandError, Context, command

BACKGROUND = (0.10, 0.10, 0.11, 1.0)
LABEL_BAR = (0.02, 0.02, 0.03, 1.0)
LABEL_TEXT = (0.95, 0.95, 0.95, 1.0)
LABEL_SCALE = 2
LABEL_BAR_HEIGHT = font5x7.GLYPH_HEIGHT * LABEL_SCALE + 8


def _load_rgba(path: str) -> np.ndarray:
    """Load an image as a top-down float RGBA array without colour management."""
    if not os.path.isfile(path):
        raise CommandError("FILE_NOT_FOUND", "No image at %s" % path)
    image = bpy.data.images.load(path, check_existing=False)
    try:
        # Reading raw keeps the sheet visually identical to the source PNGs;
        # letting Blender convert sRGB to linear would wash every cell out.
        try:
            image.colorspace_settings.name = "Non-Color"
        except (AttributeError, TypeError):
            pass
        width, height = image.size
        if width == 0 or height == 0:
            raise CommandError("EMPTY_IMAGE", "Image %s has zero size" % path)
        buffer = np.empty(width * height * 4, dtype=np.float32)
        image.pixels.foreach_get(buffer)
        # Blender buffers start at the bottom-left; flip to a top-down array.
        return np.flipud(buffer.reshape(height, width, 4))
    finally:
        bpy.data.images.remove(image)


def _fit(source: np.ndarray, box: int) -> np.ndarray:
    """Nearest-neighbour scale into a square box, preserving aspect, letterboxed."""
    height, width = source.shape[:2]
    scale = min(box / width, box / height)
    new_w = max(1, int(round(width * scale)))
    new_h = max(1, int(round(height * scale)))

    ys = np.clip((np.arange(new_h) / scale).astype(np.int32), 0, height - 1)
    xs = np.clip((np.arange(new_w) / scale).astype(np.int32), 0, width - 1)
    resized = source[ys][:, xs]

    canvas = np.empty((box, box, 4), dtype=np.float32)
    canvas[:, :] = BACKGROUND
    top = (box - new_h) // 2
    left = (box - new_w) // 2
    canvas[top : top + new_h, left : left + new_w] = resized
    return canvas


def _draw_label(canvas: np.ndarray, text: str, origin_y: int, origin_x: int, cell: int) -> None:
    canvas[origin_y : origin_y + LABEL_BAR_HEIGHT, origin_x : origin_x + cell] = LABEL_BAR
    points, text_w, text_h = font5x7.text_pixels(text.upper()[: max(1, cell // (6 * LABEL_SCALE))])
    start_x = origin_x + max(2, (cell - text_w * LABEL_SCALE) // 2)
    start_y = origin_y + (LABEL_BAR_HEIGHT - text_h * LABEL_SCALE) // 2

    height, width = canvas.shape[:2]
    for px, py in points:
        y0 = start_y + py * LABEL_SCALE
        x0 = start_x + px * LABEL_SCALE
        if 0 <= y0 < height - LABEL_SCALE and 0 <= x0 < width - LABEL_SCALE:
            canvas[y0 : y0 + LABEL_SCALE, x0 : x0 + LABEL_SCALE] = LABEL_TEXT


def _save(canvas: np.ndarray, output: str) -> Tuple[int, int]:
    height, width = canvas.shape[:2]
    image = bpy.data.images.new("ai3d_contact_sheet", width=width, height=height, alpha=True)
    try:
        try:
            image.colorspace_settings.name = "Non-Color"
        except (AttributeError, TypeError):
            pass
        # Back to Blender's bottom-up convention before handing the buffer over.
        flat = np.flipud(canvas).reshape(-1).astype(np.float32)
        image.pixels.foreach_set(flat)
        image.file_format = "PNG"
        image.filepath_raw = output
        image.save()
    finally:
        bpy.data.images.remove(image)
    if not os.path.isfile(output):
        raise CommandError("SHEET_NO_OUTPUT", "Contact sheet was not written to %s" % output)
    return width, height


@command("render.contact_sheet")
def render_contact_sheet(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    entries: List[Dict[str, str]] = params["images"]
    cell = int(params.get("cell", 512))
    columns = max(1, int(params.get("columns", 3)))
    output = common.ensure_parent_dir(common.abspath(ctx, params["output"]))

    count = len(entries)
    rows = (count + columns - 1) // columns
    gutter = 8
    cell_h = cell + LABEL_BAR_HEIGHT

    sheet_w = columns * cell + (columns + 1) * gutter
    sheet_h = rows * cell_h + (rows + 1) * gutter
    sheet = np.empty((sheet_h, sheet_w, 4), dtype=np.float32)
    sheet[:, :] = BACKGROUND

    for index, entry in enumerate(entries):
        row, column = divmod(index, columns)
        top = gutter + row * (cell_h + gutter)
        left = gutter + column * (cell + gutter)

        tile = _fit(_load_rgba(common.abspath(ctx, entry["path"])), cell)
        sheet[top : top + cell, left : left + cell] = tile
        _draw_label(sheet, entry.get("label", ""), top + cell, left, cell)

    width, height = _save(np.clip(sheet, 0.0, 1.0), output)
    ctx.log("contact sheet %dx%d with %d cells" % (width, height, count))
    return {"output": output, "width": width, "height": height}
