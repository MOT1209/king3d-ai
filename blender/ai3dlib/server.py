"""Persistent command server.

Measured on the target machine, starting Blender costs 30-90 seconds while the
commands themselves cost milliseconds. A one-process-per-batch model therefore
spends almost all of its time starting up, so the primary execution path keeps a
single Blender alive and feeds it batches over a socket.

Two hosts use this module:
  * blender/daemon.py - a background (-b) Blender owned by the CLI. No GUI needed,
    and commands run inline on the main thread, which is where bpy is safe.
  * the ai3d_bridge addon - a GUI Blender the user already has open, where work is
    handed to the main thread through bpy.app.timers instead.
"""

from __future__ import annotations

import os
import socket
import time
import traceback
from typing import Any, Callable, Dict, Optional

from . import framing, job

PROTOCOL_VERSION = 1


def handle_message(message: Dict[str, Any], allow_python_exec: bool, cwd: str) -> Dict[str, Any]:
    """Turn one request message into a response payload."""
    kind = message.get("type", "batch")

    if kind == "hello":
        from . import dispatch

        versions = dispatch.runtime_versions()
        return {
            "ok": True,
            "type": "hello",
            "protocol": PROTOCOL_VERSION,
            "pid": os.getpid(),
            "blender_version": versions["blender_version"],
            "python_version": versions["python_version"],
            "binary": versions["binary"],
        }

    if kind == "shutdown":
        return {"ok": True, "type": "shutdown"}

    if kind == "batch":
        payload = dict(message.get("job") or {})
        options = dict(payload.get("options") or {})
        # The server owns this policy; a client cannot grant itself the escape hatch.
        options["allow_python_exec"] = allow_python_exec and bool(options.get("allow_python_exec", False))
        payload["options"] = options
        context = dict(payload.get("context") or {})
        context.setdefault("cwd", cwd)
        payload["context"] = context
        result = job.run_job(payload, script_start=time.time())
        result["type"] = "batch"
        return result

    return {
        "ok": False,
        "responses": [],
        "fatal": {"code": "UNKNOWN_MESSAGE", "message": "Unknown message type '%s'" % kind},
    }


def serve(
    host: str,
    port: int,
    allow_python_exec: bool = False,
    cwd: str = "",
    on_ready: Optional[Callable[[int], None]] = None,
    executor: Optional[Callable[[Callable[[], Any]], Any]] = None,
) -> None:
    """Accept connections and serve batches until told to shut down.

    `executor` lets a GUI host marshal the actual work onto Blender's main thread;
    when it is None the work runs inline, which is correct for a background Blender
    whose main thread is this loop.
    """
    cwd = cwd or os.getcwd()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((host, port))
    listener.listen(4)

    # Printed before the first accept so the parent process can stop polling.
    print("AI3D_SERVER_READY %s:%d pid=%d" % (host, port, os.getpid()), flush=True)
    if on_ready is not None:
        on_ready(port)

    running = True
    try:
        while running:
            try:
                conn, _addr = listener.accept()
            except OSError as exc:
                print("AI3D_SERVER_ACCEPT_ERROR %s" % exc, flush=True)
                continue

            conn.settimeout(None)
            try:
                running = _serve_connection(conn, allow_python_exec, cwd, executor)
            except Exception:  # noqa: BLE001
                # One bad client must never end the session: restarting Blender
                # costs 30-90s, so the server survives anything a peer does.
                print("AI3D_SERVER_CONNECTION_ERROR %s" % traceback.format_exc(limit=8), flush=True)
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
    finally:
        listener.close()
        print("AI3D_SERVER_STOPPED", flush=True)


def _serve_connection(
    conn: socket.socket,
    allow_python_exec: bool,
    cwd: str,
    executor: Optional[Callable[[Callable[[], Any]], Any]],
) -> bool:
    """Serve one connection. Returns False when the client asked to shut down."""
    while True:
        try:
            message = framing.read_frame(conn)
        except framing.FrameError as exc:
            _try_write(conn, {"ok": False, "fatal": {"code": "FRAME_ERROR", "message": str(exc)}})
            return True
        if message is None:
            return True  # client disconnected

        try:
            if executor is None:
                response = handle_message(message, allow_python_exec, cwd)
            else:
                response = executor(lambda m=message: handle_message(m, allow_python_exec, cwd))
        except Exception as exc:  # noqa: BLE001 - report the failure, keep serving
            response = {
                "ok": False,
                "responses": [],
                "fatal": {
                    "code": "SERVER_EXCEPTION",
                    "message": "%s: %s" % (type(exc).__name__, exc),
                    "traceback": traceback.format_exc(limit=12),
                },
            }

        if not _try_write(conn, response):
            return True
        if message.get("type") == "shutdown":
            return False


def _try_write(conn: socket.socket, payload: Dict[str, Any]) -> bool:
    """Write a reply, tolerating a client that has already gone away."""
    try:
        framing.write_frame(conn, payload)
        return True
    except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, OSError):
        return False
