"""Blender-side unit tests.

Run with:
    blender -b --factory-startup -noaudio --python blender/tests/run_tests.py

bpy only exists inside Blender, so this code cannot be tested from vitest or a
plain Python interpreter - the suite has to run in the same interpreter it drives.
Exits non-zero on failure so it can gate a commit.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_BLENDER_DIR = os.path.dirname(_HERE)
if _BLENDER_DIR not in sys.path:
    sys.path.insert(0, _BLENDER_DIR)

import bpy  # noqa: E402

from ai3dlib import dispatch, framing, job  # noqa: E402


def fresh_context() -> dispatch.Context:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return dispatch.Context(cwd=tempfile.gettempdir(), allow_python_exec=False)


def run(cmd: str, params: dict, ctx: dispatch.Context) -> dict:
    return dispatch.execute({"id": cmd, "cmd": cmd, "params": params}, ctx)


def ok(test: unittest.TestCase, response: dict) -> dict:
    test.assertTrue(
        response["ok"],
        "%s failed: %s" % (response["id"], response.get("error")),
    )
    return response["result"]


class TestFraming(unittest.TestCase):
    def test_encode_has_big_endian_length_header(self):
        frame = framing.encode({"a": 1})
        import struct

        (length,) = struct.unpack(">I", frame[:4])
        self.assertEqual(length, len(frame) - 4)

    def test_encode_round_trips_unicode(self):
        import json

        frame = framing.encode({"text": "نموذج ثلاثي الأبعاد"})
        self.assertEqual(json.loads(frame[4:].decode("utf-8"))["text"], "نموذج ثلاثي الأبعاد")


class TestDispatch(unittest.TestCase):
    def setUp(self):
        job.ensure_handlers()
        self.ctx = fresh_context()

    def test_every_protocol_command_has_a_handler(self):
        # Kept in step with src/integrations/blender/protocol.ts by hand; this
        # test is what catches the two lists drifting apart.
        expected = {
            "ping",
            "scene.info",
            "scene.reset",
            "object.create",
            "object.transform",
            "object.delete",
            "object.modifier",
            "object.boolean",
            "object.join",
            "material.assign",
            "light.create",
            "camera.set",
            "camera.frame",
            "world.set",
            "render.still",
            "render.views",
            "render.contact_sheet",
            "inspect.mesh",
            "inspect.all",
            "optimize.decimate",
            "uv.unwrap",
            "export.glb",
            "import.glb",
            "python.exec",
        }
        self.assertEqual(expected - set(dispatch.registered_commands()), set())

    def test_unknown_command_is_reported_not_raised(self):
        response = run("scene.explode", {}, self.ctx)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "UNKNOWN_COMMAND")

    def test_handler_exception_becomes_an_error_response(self):
        response = run("inspect.mesh", {"object": "does_not_exist"}, self.ctx)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "OBJECT_NOT_FOUND")

    def test_batch_stops_at_first_failure(self):
        responses = dispatch.execute_batch(
            [
                {"id": "1", "cmd": "ping", "params": {}},
                {"id": "2", "cmd": "inspect.mesh", "params": {"object": "nope"}},
                {"id": "3", "cmd": "ping", "params": {}},
            ],
            self.ctx,
        )
        self.assertTrue(responses[0]["ok"])
        self.assertFalse(responses[1]["ok"])
        self.assertFalse(responses[2]["ok"])
        self.assertEqual(responses[2]["error"]["code"], "SKIPPED")

    def test_python_exec_is_denied_by_default(self):
        response = run("python.exec", {"code": "result = 1"}, self.ctx)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "PYTHON_EXEC_DISABLED")


class TestGeometry(unittest.TestCase):
    def setUp(self):
        job.ensure_handlers()
        self.ctx = fresh_context()

    def test_create_cube_with_explicit_dimensions(self):
        result = ok(self, run("object.create", {"kind": "cube", "name": "box", "dimensions": [2, 1, 0.5]}, self.ctx))
        self.assertEqual(result["name"], "box")
        for got, want in zip(result["dimensions"], [2, 1, 0.5]):
            self.assertAlmostEqual(got, want, places=4)

    def test_duplicate_name_is_rejected(self):
        ok(self, run("object.create", {"kind": "cube", "name": "box"}, self.ctx))
        response = run("object.create", {"kind": "cube", "name": "box"}, self.ctx)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "NAME_TAKEN")

    def test_world_dimensions_account_for_rotation(self):
        import math

        ok(
            self,
            run(
                "object.create",
                {
                    "kind": "cube",
                    "name": "flat",
                    "dimensions": [2, 1, 0.5],
                    "rotation_euler": [math.pi / 2, 0, 0],
                },
                self.ctx,
            ),
        )
        stats = ok(self, run("inspect.mesh", {"object": "flat"}, self.ctx))
        # Local dimensions ignore rotation; world dimensions must not.
        self.assertAlmostEqual(stats["world_dimensions"][1], 0.5, places=3)
        self.assertAlmostEqual(stats["world_dimensions"][2], 1.0, places=3)

    def test_boolean_difference_hollows_a_solid(self):
        ok(self, run("object.create", {"kind": "cube", "name": "outer", "dimensions": [1, 1, 1]}, self.ctx))
        ok(
            self,
            run(
                "object.create",
                {"kind": "cube", "name": "inner", "dimensions": [0.6, 0.6, 2.0], "location": [0, 0, 0]},
                self.ctx,
            ),
        )
        before = ok(self, run("inspect.mesh", {"object": "outer"}, self.ctx))
        ok(self, run("object.boolean", {"object": "outer", "cutter": "inner", "operation": "DIFFERENCE"}, self.ctx))
        after = ok(self, run("inspect.mesh", {"object": "outer"}, self.ctx))
        self.assertGreater(after["faces"], before["faces"])
        self.assertLess(after["volume"], before["volume"])
        self.assertIsNone(bpy.data.objects.get("inner"), "cutter should have been removed")

    def test_transform_apply_normalises_scale(self):
        ok(self, run("object.create", {"kind": "cube", "name": "s", "scale": [2, 2, 2]}, self.ctx))
        before = ok(self, run("inspect.mesh", {"object": "s"}, self.ctx))
        self.assertFalse(before["transform_applied"])
        ok(self, run("object.transform", {"name": "s", "apply": True}, self.ctx))
        after = ok(self, run("inspect.mesh", {"object": "s"}, self.ctx))
        self.assertTrue(after["transform_applied"])
        # Applying scale must not change the object's actual size.
        for got, want in zip(after["world_dimensions"], before["world_dimensions"]):
            self.assertAlmostEqual(got, want, places=4)

    def test_decimate_respects_a_triangle_budget(self):
        ok(
            self,
            run(
                "object.create",
                {"kind": "uv_sphere", "name": "ball", "options": {"segments": 64, "ring_count": 32}},
                self.ctx,
            ),
        )
        before = ok(self, run("inspect.mesh", {"object": "ball"}, self.ctx))
        result = ok(self, run("optimize.decimate", {"objects": ["ball"], "target_tris": 500}, self.ctx))
        self.assertEqual(result["before_tris"], before["tris"])
        self.assertLess(result["after_tris"], before["tris"])
        # Collapse is approximate; allow slack but insist it is in the right region.
        self.assertLess(result["after_tris"], 800)


class TestMaterials(unittest.TestCase):
    def setUp(self):
        job.ensure_handlers()
        self.ctx = fresh_context()

    def test_assign_material_fills_the_slot(self):
        ok(self, run("object.create", {"kind": "cube", "name": "c"}, self.ctx))
        result = ok(
            self,
            run(
                "material.assign",
                {
                    "object": "c",
                    "material": {
                        "name": "red_metal",
                        "base_color": [0.8, 0.1, 0.1, 1.0],
                        "metallic": 1.0,
                        "roughness": 0.2,
                    },
                },
                self.ctx,
            ),
        )
        self.assertEqual(result["material"], "red_metal")
        stats = ok(self, run("inspect.mesh", {"object": "c"}, self.ctx))
        self.assertEqual(stats["material_slots"], 1)
        self.assertEqual(stats["empty_material_slots"], 0)

    def test_material_values_reach_the_shader(self):
        ok(self, run("object.create", {"kind": "cube", "name": "c"}, self.ctx))
        ok(
            self,
            run(
                "material.assign",
                {"object": "c", "material": {"name": "m", "metallic": 0.75, "roughness": 0.25}},
                self.ctx,
            ),
        )
        node = bpy.data.materials["m"].node_tree.nodes.get("Principled BSDF")
        self.assertIsNotNone(node)
        self.assertAlmostEqual(node.inputs["Metallic"].default_value, 0.75, places=4)
        self.assertAlmostEqual(node.inputs["Roughness"].default_value, 0.25, places=4)


class TestSceneAndExport(unittest.TestCase):
    def setUp(self):
        job.ensure_handlers()
        self.ctx = fresh_context()

    def test_reset_purges_orphaned_datablocks(self):
        ok(self, run("object.create", {"kind": "cube", "name": "c"}, self.ctx))
        ok(self, run("material.assign", {"object": "c", "material": {"name": "m"}}, self.ctx))
        ok(self, run("scene.reset", {}, self.ctx))
        info = ok(self, run("scene.info", {}, self.ctx))
        self.assertEqual(info["counts"]["objects"], 0)
        self.assertEqual(info["counts"]["orphan_meshes"], 0)
        self.assertEqual(info["counts"]["orphan_materials"], 0)

    def test_glb_round_trip_preserves_triangle_count(self):
        # An exporter reporting success is not proof the file loads, so the
        # export gate re-imports and compares.
        ok(self, run("object.create", {"kind": "uv_sphere", "name": "ball"}, self.ctx))
        ok(self, run("material.assign", {"object": "ball", "material": {"name": "m"}}, self.ctx))
        before = ok(self, run("inspect.mesh", {"object": "ball"}, self.ctx))

        out = os.path.join(tempfile.gettempdir(), "ai3d_test_roundtrip.glb")
        export = ok(self, run("export.glb", {"output": out, "objects": ["ball"]}, self.ctx))
        self.assertTrue(os.path.isfile(export["output"]))
        self.assertGreater(export["size_bytes"], 0)

        imported = ok(self, run("import.glb", {"path": out, "reset_scene": True}, self.ctx))
        self.assertEqual(imported["total_tris"], before["tris"])
        os.remove(out)

    def test_missing_blend_is_an_error_not_an_empty_scene(self):
        result = job.run_job(
            {
                "commands": [{"id": "1", "cmd": "scene.info", "params": {}}],
                "context": {"load_blend": os.path.join(tempfile.gettempdir(), "definitely_absent.blend")},
            }
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["fatal"]["code"], "SCENE_OPEN_FAILED")


class TestCameraMath(unittest.TestCase):
    def test_fit_distance_grows_with_radius(self):
        from ai3dlib import camera

        near = camera.fit_distance(1.0, 50.0, 36.0, 512, 512, 1.0)
        far = camera.fit_distance(2.0, 50.0, 36.0, 512, 512, 1.0)
        self.assertAlmostEqual(far / near, 2.0, places=6)

    def test_wider_lens_lets_the_camera_come_closer(self):
        from ai3dlib import camera

        wide = camera.fit_distance(1.0, 24.0, 36.0, 512, 512, 1.0)
        tele = camera.fit_distance(1.0, 85.0, 36.0, 512, 512, 1.0)
        self.assertLess(wide, tele)

    def test_orbit_positions_match_blender_view_conventions(self):
        from ai3dlib import camera

        front = camera.orbit_position((0, 0, 0), 10.0, 0.0, 0.0)
        self.assertAlmostEqual(front[1], -10.0, places=6)  # front view looks from -Y
        right = camera.orbit_position((0, 0, 0), 10.0, 90.0, 0.0)
        self.assertAlmostEqual(right[0], 10.0, places=6)  # right view looks from +X


def main() -> int:
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2, stream=sys.stdout).run(suite)
    print("AI3D_BLENDER_TESTS %s" % ("PASSED" if result.wasSuccessful() else "FAILED"), flush=True)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
