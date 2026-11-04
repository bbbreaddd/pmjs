import unittest
from unittest.mock import patch

from llvm_tools import llvm_strip


class StripToolTests(unittest.TestCase):
    def test_finds_supported_version_and_skips_unsupported(self):
        with patch("llvm_tools.shutil.which", side_effect=lambda name: "/bin/" + name), \
             patch("llvm_tools.subprocess.check_output", side_effect=["LLVM version 17.0.0", "Debian LLVM version 19.1.7"]):
            self.assertEqual(llvm_strip(), ("/bin/llvm-strip-19", "19.1.7"))

    def test_x64_requires_exact_version(self):
        with patch("llvm_tools.shutil.which", return_value="/bin/llvm-strip"), \
             patch("llvm_tools.subprocess.check_output", return_value="LLVM version 19.1.7"):
            with self.assertRaisesRegex(ValueError, "20.1.2"):
                llvm_strip(exact="20.1.2")

    def test_accepts_llvm_18(self):
        with patch("llvm_tools.shutil.which", side_effect=lambda name: "/bin/" + name if name == "llvm-strip-18" else None), \
             patch("llvm_tools.subprocess.check_output", return_value="Ubuntu LLVM version 18.1.3"):
            self.assertEqual(llvm_strip(), ("/bin/llvm-strip-18", "18.1.3"))

    def test_missing_strip_reports_requirement(self):
        with patch("llvm_tools.shutil.which", return_value=None):
            with self.assertRaisesRegex(ValueError, "18, 19 or 20"):
                llvm_strip()


if __name__ == "__main__":
    unittest.main()
