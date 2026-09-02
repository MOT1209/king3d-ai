"""Command dispatch shared by both backends.

The headless runner and the live addon are thin transports around this module,
so every bpy operation exists in exactly one place. Handlers take a params dict
and return a JSON-serialisable dict; raising is how a command fails.
"""

from __future__ import annotations

import io
import sys
import time
import traceback
from contextlib import redirect_stdout
from typing import Any, Callable, Dict, List

Handler = Callable[[Dict[str, Any], "Context"], Any]

_REGISTRY: Dict[str, Handler] = {}


class CommandError(Exception):
    """Raised by handlers for an expected, reportable failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class Context:
    """Per-job state handed to every handler."""

    def __init__(self, cwd: str = "", allow_python_exec: bool = False):
        self.cwd = cwd
        self.allow_python_exec = allow_python_exec
        self.logs: List[str] = []

    def log(self, message: str) -> None:
        self.logs.append(str(message))

    def take_logs(self) -> List[str]:
        logs, self.logs = self.logs, []
        return logs


def command(name: str) -> Callable[[Handler], Handler]:
    """Register a handler under its wire name."""

    def decorator(fn: Handler) -> Handler:
        if name in _REGISTRY:
            raise RuntimeError("duplicate command registration: %s" % name)
        _REGISTRY[name] = fn
        return fn

    return decorator


def registered_commands() -> List[str]:
    return sorted(_REGISTRY)


def load_handlers() -> None:
    """Import every handler module exactly once."""
    from . import (  # noqa: F401
        camera,
        contact_sheet,
        exporter,
        inspect_mesh,
        lighting,
        materials,
        optimize,
        primitives,
        pyexec,
        render,
        scene,
    )


def execute(request: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
    """Run one command, converting any failure into a response envelope."""
    cmd = request.get("cmd", "")
    req_id = request.get("id", cmd)
    params = request.get("params") or {}
    started = time.time()

    handler = _REGISTRY.get(cmd)
    if handler is None:
        return {
            "id": req_id,
            "ok": False,
            "error": {
                "code": "UNKNOWN_COMMAND",
                "message": "No handler registered for '%s'. Known: %s" % (cmd, ", ".join(registered_commands())),
            },
            "logs": ctx.take_logs(),
            "duration_ms": 0,
        }

    stdout_capture = io.StringIO()
    try:
        # Blender operators print freely; keep stdout out of the result stream.
        with redirect_stdout(stdout_capture):
            result = handler(params, ctx)
        captured = stdout_capture.getvalue().strip()
        logs = ctx.take_logs()
        if captured:
            logs.extend(captured.splitlines()[-20:])
        return {
            "id": req_id,
            "ok": True,
            "result": result,
            "logs": logs,
            "duration_ms": int((time.time() - started) * 1000),
        }
    except CommandError as exc:
        return {
            "id": req_id,
            "ok": False,
            "error": {"code": exc.code, "message": exc.message},
            "logs": ctx.take_logs(),
            "duration_ms": int((time.time() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001 - the boundary must not leak
        return {
            "id": req_id,
            "ok": False,
            "error": {
                "code": "HANDLER_EXCEPTION",
                "message": "%s: %s" % (type(exc).__name__, exc),
                "traceback": traceback.format_exc(limit=12),
            },
            "logs": ctx.take_logs(),
            "duration_ms": int((time.time() - started) * 1000),
        }


def execute_batch(requests: List[Dict[str, Any]], ctx: Context) -> List[Dict[str, Any]]:
    """Run commands in order, stopping at the first failure.

    Continuing after a failure would build on a scene that is already wrong, so
    the remaining commands are reported as skipped rather than executed.
    """
    responses: List[Dict[str, Any]] = []
    failed = False
    for request in requests:
        if failed:
            responses.append(
                {
                    "id": request.get("id", request.get("cmd", "")),
                    "ok": False,
                    "error": {"code": "SKIPPED", "message": "Skipped: an earlier command in the batch failed"},
                    "logs": [],
                    "duration_ms": 0,
                }
            )
            continue
        response = execute(request, ctx)
        responses.append(response)
        if not response["ok"]:
            failed = True
    return responses


def runtime_versions() -> Dict[str, str]:
    import bpy

    return {
        "blender_version": bpy.app.version_string,
        "python_version": sys.version.split()[0],
        "binary": bpy.app.binary_path,
    }
