import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

from provision import ROOT, LOCK, digest
from unittest.mock import patch
from types import SimpleNamespace
import raster


class PatchTests(unittest.TestCase):
    def test_arm_parity_patch_applies_to_pinned_source(self):
        fixture = ROOT / "test/assets/skia65/arm-parity-source"
        provenance = json.loads(fixture.with_suffix(".json").read_text())
        self.assertEqual(provenance["revision"], json.loads(LOCK.read_text())["skia"])
        temporary_root = ROOT / ".cache/tests"
        temporary_root.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=temporary_root, prefix="skia-patch-") as directory:
            source = pathlib.Path(directory)
            with tarfile.open(fixture.with_suffix(".tar.gz")) as archive:
                archive.extractall(source, filter="data")
            for name, checksum in provenance["files"].items():
                self.assertEqual(digest(source / name), checksum, name)
            patch = ROOT / "third_party/skia65-arm-parity.patch"
            environment = {**os.environ, "GIT_CEILING_DIRECTORIES": str(source.parent)}
            for arguments in (["--check"], []):
                result = subprocess.run(["git", "apply", *arguments, patch], cwd=source,
                                        env=environment, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)


class RasterCacheTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = pathlib.Path(self.directory.name) / "cache"
        self.output = pathlib.Path(self.directory.name) / "output"
        self.output.mkdir()
        self.cache.joinpath("skia").mkdir(parents=True)
        self.cache.joinpath("skia/source.cpp").write_text("pinned adapted source")
        self.output.joinpath("libskia.a").write_text("verified archive")
        self.toolchain = {"compilerSha256": "compiler", "stripSha256": "strip"}
        self.args = {"target_cpu": "arm64"}
        self.expected = raster.recipe(self.toolchain, self.args)
        self.output.joinpath("raster.json").write_text(json.dumps({
            "recipe": self.expected, "archive": digest(self.output / "libskia.a"),
            "inputs": raster.inputs(self.cache), "adaptations": {"checked": True}}))

    def test_bridge_changes_reuse_upstream_without_provisioning_or_writes(self):
        before = {str(file): file.stat().st_mtime_ns for file in self.cache.rglob("*") if file.is_file()}
        # Bridge code and component configuration are deliberately outside the upstream recipe.
        self.cache.parent.joinpath("bridge.cpp").write_text("changed bridge")
        with patch.object(raster, "provision", side_effect=AssertionError("unexpected provisioning")):
            adaptations = raster.build_raster(SimpleNamespace(arch="arm64"), self.cache, self.output,
                                               self.toolchain, self.args, None, None, None)
        self.assertEqual(adaptations, {"checked": True})
        self.assertEqual(before, {str(file): file.stat().st_mtime_ns for file in self.cache.rglob("*") if file.is_file()})

    def test_corrupted_archive_and_sources_invalidate_reuse(self):
        self.output.joinpath("libskia.a").write_text("corrupt archive")
        self.assertEqual(raster.reusable(self.cache, self.output, self.expected), "upstream archive changed")
        record = json.loads(self.output.joinpath("raster.json").read_text())
        record["archive"] = digest(self.output / "libskia.a")
        self.output.joinpath("raster.json").write_text(json.dumps(record))
        self.cache.joinpath("skia/source.cpp").write_text("corrupt source")
        self.assertEqual(raster.reusable(self.cache, self.output, self.expected), "provisioned raster sources changed")

    def test_compiler_changes_invalidate_upstream_but_strip_changes_do_not(self):
        self.toolchain["stripSha256"] = "new strip"
        self.assertEqual(raster.recipe(self.toolchain, self.args), self.expected)
        self.toolchain["compilerSha256"] = "new compiler"
        self.assertEqual(raster.reusable(self.cache, self.output, raster.recipe(self.toolchain, self.args)), "upstream recipe changed")


if __name__ == "__main__":
    unittest.main()
