import copy
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

import artifact
from provision import LOCK, digest


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = pathlib.Path(self.temporary.name)
        self.library = self.directory / "libpmjs-skia65.so"
        self.library.write_bytes(b"\x7fELF\x02\x01" + bytes(12) + bytes([62, 0]) + b"fixture")
        self.source = patch.object(artifact, "source_hashes", return_value={"source.cpp": "original"})
        self.source.start()
        self.addCleanup(self.source.stop)
        lock = json.loads(LOCK.read_text())
        self.manifest = {"arch": "x64", "dependencies": lock, "sources": artifact.source_hashes(),
            "configuration": artifact.configuration("x64", "llvm-ar-20"),
            "compilerVersion": "clang version " + lock["clangVersion"] + " fixture",
            "strip": {"version": lock["clangVersion"]}, "toolchain": {"compiler": "original"},
            "librarySha256": digest(self.library), "libraryBytes": self.library.stat().st_size}

    def write(self, manifest=None):
        (self.directory / "manifest.json").write_text(json.dumps(manifest or self.manifest))

    def test_valid_prebuilt_can_be_verified_without_a_host_compiler(self):
        self.write()
        self.assertEqual(artifact.validate(self.directory, "x64"), self.manifest)

    def test_arm64_accepts_supported_strip_versions(self):
        self.library.write_bytes(b"\x7fELF\x02\x01" + bytes(12) + bytes([183, 0]) + b"fixture")
        self.manifest.update(arch="arm64", configuration=artifact.configuration("arm64", "ar"),
            compilerVersion="0.15.2", librarySha256=digest(self.library), libraryBytes=self.library.stat().st_size)
        for version in ("18.1.3", "19.1.7", "20.1.2"):
            self.manifest["strip"] = {"version": version}
            self.write()
            artifact.validate(self.directory, "arm64")
        self.manifest["strip"] = {"version": "17.0.6"}
        self.write()
        with self.assertRaisesRegex(RuntimeError, "unsupported strip version"):
            artifact.validate(self.directory, "arm64")

    def test_changed_producer_inputs_are_rejected(self):
        for key, value in [("arch", "arm64"), ("dependencies", {}), ("sources", {}),
            ("compilerVersion", "clang version 99"), ("strip", {"version": "99"})]:
            with self.subTest(key=key):
                changed = {**self.manifest, key: value}
                self.write(changed)
                with self.assertRaisesRegex(RuntimeError, "Invalid Skia65 component"):
                    artifact.validate(self.directory, "x64")
        changed = copy.deepcopy(self.manifest)
        changed["configuration"]["extra_cflags"].append("-ffast-math")
        self.write(changed)
        with self.assertRaisesRegex(RuntimeError, "configuration changed"):
            artifact.validate(self.directory, "x64")

    def test_reuse_requires_the_current_compiler_and_sdk_identity(self):
        self.write()
        artifact.validate(self.directory, "x64", self.manifest["toolchain"])
        with self.assertRaisesRegex(RuntimeError, "compiler or SDK changed"):
            artifact.validate(self.directory, "x64", {"compiler": "replacement"})

    def test_corrupt_library_and_forged_architecture_metadata_are_rejected(self):
        self.write()
        self.library.write_bytes(self.library.read_bytes() + b"modified")
        with self.assertRaisesRegex(RuntimeError, "checksum or size changed"):
            artifact.validate(self.directory, "x64")
        self.library.write_bytes(b"\x7fELF\x02\x01" + bytes(12) + bytes([183, 0]) + b"fixture")
        self.manifest.update(librarySha256=digest(self.library), libraryBytes=self.library.stat().st_size)
        self.write()
        with self.assertRaisesRegex(RuntimeError, "ELF architecture"):
            artifact.validate(self.directory, "x64")

    def test_incomplete_and_missing_manifests_are_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "Invalid Skia65 component"):
            artifact.validate(self.directory, "x64")
        self.write({"arch": "x64"})
        with self.assertRaisesRegex(RuntimeError, "Invalid Skia65 component"):
            artifact.validate(self.directory, "x64")

    def test_test_source_changes_only_invalidate_requested_tests(self):
        self.source.stop()
        source_root = artifact.ROOT
        fixture = self.directory / "source"
        for name in artifact.source_hashes(mask_test=True):
            target = fixture / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_root / name, target)
        with patch.object(artifact, "ROOT", fixture), \
             patch.object(artifact, "LOCK", fixture / "tools/skia65/sources.lock.json"), \
             patch.object(artifact, "__file__", str(fixture / "tools/skia65/artifact.py")):
            self.manifest["sources"] = artifact.source_hashes(mask_test=True)
            self.write()
            artifact.validate(self.directory, "x64", mask_test=True)
            for name in ("mask_test.cpp", "raster_test.cpp"):
                with self.subTest(name=name):
                    file = fixture / "src/skia65" / name
                    file.write_text(file.read_text() + "\n// Test-only change\n")
                    artifact.validate(self.directory, "x64")
                    with self.assertRaisesRegex(RuntimeError, "component sources changed"):
                        artifact.validate(self.directory, "x64", mask_test=True)
            production = fixture / "src/skia65/pmjs_skia65.cpp"
            production.write_text(production.read_text() + "\n// Production change\n")
            with self.assertRaisesRegex(RuntimeError, "component sources changed"):
                artifact.validate(self.directory, "x64")
            self.manifest["sources"] = artifact.source_hashes()
            self.write()
            artifact.validate(self.directory, "x64")
            with self.assertRaisesRegex(RuntimeError, "component sources changed"):
                artifact.validate(self.directory, "x64", mask_test=True)


if __name__ == "__main__":
    unittest.main()
