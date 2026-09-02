"""Persistent headless Blender.

Invoked as:
    blender -b --factory-startup -noaudio --python daemon.py -- --port 9877 [--host 127.0.0.1]

Starts the command server on Blender's main thread and blocks. The CLI owns the
process lifetime; every batch after the first therefore skips Blender's 30-90s
startup entirely.
"""

from __future__ import annotations

import os
import sys
import traceback

_ARGV = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def _arg(name: str, default=None):
    if name in _ARGV:
        index = _ARGV.index(name)
        if index + 1 < len(_ARGV):
            return _ARGV[index + 1]
    return default


def main() -> int:
    host = _arg("--host", "127.0.0.1")
    port = int(_arg("--port", "9877"))
    cwd = _arg("--cwd", os.getcwd())
    allow_python_exec = "--allow-python-exec" in _ARGV

    try:
        from ai3dlib import job, server

        # Import the handler modules now rather than on the first batch, so the
        # cost lands in startup where the CLI is already waiting for readiness.
        job.ensure_handlers()
        server.serve(host=host, port=port, allow_python_exec=allow_python_exec, cwd=cwd)
        return 0
    except OSError as exc:
        sys.stderr.write("AI3D_SERVER_ERROR bind failed on %s:%d: %s\n" % (host, port, exc))
        return 4
    except Exception:  # noqa: BLE001
        sys.stderr.write("AI3D_SERVER_ERROR %s\n" % traceback.format_exc(limit=20))
        return 5


if __name__ == "__main__":
    sys.exit(main())
