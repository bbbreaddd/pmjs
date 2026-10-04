import copy
import json
import pathlib
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


if __name__ == "__main__":
    unittest.main()
