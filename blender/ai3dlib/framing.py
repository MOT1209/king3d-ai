"""Length-prefixed JSON framing - the Python half of src/integrations/blender/frame.ts.

Every message is a 4-byte big-endian length followed by that many UTF-8 bytes of
JSON. Message boundaries are therefore explicit, which is what lets a large
result (a mesh dump, an image path list) cross the socket intact.
"""

from __future__ import annotations

import json
import socket
import struct
from typing import Any, Optional

HEADER_BYTES = 4
MAX_FRAME_BYTES = 64 * 1024 * 1024


class FrameError(Exception):
    pass


def encode(payload: Any) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise FrameError("outgoing frame too large: %d bytes" % len(body))
    return struct.pack(">I", len(body)) + body


def _recv_exactly(conn: socket.socket, count: int) -> Optional[bytes]:
    chunks = []
    remaining = count
    while remaining > 0:
        try:
            chunk = conn.recv(min(remaining, 65536))
        except (ConnectionResetError, ConnectionAbortedError, OSError):
            # A peer that vanishes mid-read is a disconnect, not a server fault.
            # Reachability probes disconnect abruptly by design, and an unhandled
            # reset here would take the whole server down with them.
            return None
        if not chunk:
            return None  # peer closed cleanly
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(conn: socket.socket) -> Optional[Any]:
    """Read one whole message, or None when the peer closed cleanly."""
    header = _recv_exactly(conn, HEADER_BYTES)
    if header is None:
        return None
    (length,) = struct.unpack(">I", header)
    if length > MAX_FRAME_BYTES:
        raise FrameError("incoming frame claims %d bytes; refusing" % length)
    body = _recv_exactly(conn, length)
    if body is None:
        raise FrameError("connection closed mid-frame (%d bytes expected)" % length)
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise FrameError("frame body is not valid JSON: %s" % exc)


def write_frame(conn: socket.socket, payload: Any) -> None:
    conn.sendall(encode(payload))
