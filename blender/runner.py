"""One-shot headless entry point.

Invoked as:
    blender -b --factory-startup -noaudio --python runner.py -- --job JOB.json --result RESULT.json

Executes a single batch and exits. Correct and dependency-free, but it pays
Blender's full startup every time, so it is the fallback path: the daemon
(blender/daemon.py) is what the pipeline normally talks to. Kept for CI, for
one-off commands, and as the thing to fall back to when a daemon cannot start.

A crash here must still produce a diagnosable JSON - an empty result file gives
the caller nothing to report.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback

# Captured before anything else so the caller can see how much of a batch was
# Blender starting up rather than doing work. On slow hardware that dominates.
_SCRIPT_START = time.time()

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


def _write_result(path: str, payload: dict) -> None:
    directory = os.path.dirname(path)
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def main() -> int:
    job_path = _arg("--job")
    result_path = _arg("--result")
    if not job_path or not result_path:
        sys.stderr.write("runner.py requires --job and --result\n")
        return 2

    try:
        from ai3dlib import job as job_module

        with open(job_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)

        result = job_module.run_job(payload, script_start=_SCRIPT_START)
        _write_result(result_path, result)
        return 0 if result.get("ok") else 1

    except Exception as exc:  # noqa: BLE001 - the process boundary must report, not crash
        _write_result(
            result_path,
            {
                "ok": False,
                "responses": [],
                "fatal": {
                    "code": "RUNNER_EXCEPTION",
                    "message": "%s: %s" % (type(exc).__name__, exc),
                    "traceback": traceback.format_exc(limit=20),
                },
            },
        )
        return 3


if __name__ == "__main__":
    sys.exit(main())
