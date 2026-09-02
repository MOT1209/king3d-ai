"""Guarded arbitrary-Python escape hatch.

Deliberately off by default. blender-mcp exposes this as its primary interface,
which makes every operation an unvalidated string; here it exists only as a last
resort for debugging and must be enabled explicitly via AI3D_ALLOW_PYTHON_EXEC=1.
"""

from __future__ import annotations

import io
from contextlib import redirect_stdout
from typing import Any, Dict

from .dispatch import CommandError, Context, command


@command("python.exec")
def python_exec(params: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    if not getattr(ctx, "allow_python_exec", False):
        raise CommandError(
            "PYTHON_EXEC_DISABLED",
            "python.exec is disabled. Set AI3D_ALLOW_PYTHON_EXEC=1 to enable it for this run.",
        )

    code = params.get("code") or ""
    if not code.strip():
        raise CommandError("EMPTY_CODE", "python.exec requires non-empty code")

    import bpy  # noqa: F401 - exposed to the executed snippet

    namespace: Dict[str, Any] = {"bpy": bpy, "__name__": "ai3d_exec"}
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        exec(compile(code, "<ai3d.python.exec>", "exec"), namespace)  # noqa: S102 - intentional, gated

    value = namespace.get("result")
    return {"stdout": buffer.getvalue(), "value": None if value is None else repr(value)}
