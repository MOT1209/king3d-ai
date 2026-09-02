"""ai3dlib - the Blender-side half of the AI 3D agent platform.

Imported by both transports:
  * blender/runner.py          (headless, one process per batch)
  * blender/addon/ai3d_bridge  (live socket server inside a running Blender)

Standard library plus bpy only - no pip installs into Blender's interpreter.
"""

__version__ = "0.1.0"
