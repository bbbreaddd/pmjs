import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

from provision import ROOT, LOCK, digest


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


if __name__ == "__main__":
    unittest.main()
