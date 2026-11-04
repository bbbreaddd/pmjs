import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import build
import dependencies


class BuildTests(unittest.TestCase):
    def test_cross_build_reports_unsupported_host_and_python_before_preparing(self):
        with patch.object(dependencies.platform, 'machine', return_value='aarch64'), \
             patch.object(dependencies, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'x86-64 Linux host'):
                dependencies.prepare_arm64(2)
            run.assert_not_called()
        with patch.object(dependencies.platform, 'machine', return_value='x86_64'), \
             patch.object(dependencies, 'tarfile', SimpleNamespace()), \
             patch.object(dependencies, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'tarfile extraction filters'):
                dependencies.prepare_arm64(2)
            run.assert_not_called()

    def test_arm64_prepares_before_build_and_installs_result(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "runtime"
            calls = []
            with patch.object(sys, "argv", ["build.py", "--target", "arm64", "--jobs", "2", "--output", str(output)]), \
                 patch.object(build, "require"), \
                 patch.object(build, "prepare_arm64", side_effect=lambda jobs: calls.append(("prepare", jobs))), \
                 patch.object(build, "run", side_effect=lambda *args, **kwargs: calls.append(("run", args))), \
                 patch.object(build, "checked_runtime"):
                build.main()
            self.assertEqual(calls[0], ("prepare", 2))
            self.assertEqual(calls[1][1][:2], ("cmake", "--preset"))
            self.assertTrue(output.is_dir())

    def test_preparation_failure_preserves_existing_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            output = pathlib.Path(directory) / "runtime"
            output.mkdir()
            marker = output / "build-info.json"
            marker.write_text("original")
            with patch.object(sys, "argv", ["build.py", "--target", "arm64", "--jobs", "3", "--output", str(output)]), \
                 patch.object(build, "require"), patch.object(build, "recognize_runtime"), \
                 patch.object(build, "prepare_arm64", side_effect=ValueError("missing tool")) as prepare, \
                 patch.object(build, "run") as run:
                with self.assertRaisesRegex(ValueError, "missing tool"):
                    build.main()
                prepare.assert_called_once_with(3)
                run.assert_not_called()
            self.assertEqual(marker.read_text(), "original")


if __name__ == "__main__":
    unittest.main()
