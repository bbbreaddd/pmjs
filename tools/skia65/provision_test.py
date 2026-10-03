import hashlib
import pathlib
import tempfile
import unittest
from unittest.mock import patch

from provision import download, extract_member


class ProvisionTests(unittest.TestCase):
    def test_extraction_preserves_unchanged_inputs_and_restores_modified_source(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            archive = root / 'source.tar'
            with tarfile.open(archive, 'w') as tar:
                entry = tarfile.TarInfo('source.cpp')
                entry.size = len(b'original')
                tar.addfile(entry, io.BytesIO(b'original'))
            with tarfile.open(archive) as tar:
                member = tar.getmembers()[0]
                extract_member(tar, member, root)
                source = root / member.name
                before = source.stat().st_mtime_ns
                extract_member(tar, member, root)
                self.assertEqual(source.stat().st_mtime_ns, before)
                source.write_bytes(b'adapted')
                extract_member(tar, member, root)
                self.assertEqual(source.read_bytes(), b'original')

    def test_corrupt_cache_fails_without_network_or_replacing_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "source.bin"
            file.write_bytes(b"changed")
            checksum = hashlib.sha256(b"original").hexdigest()
            with patch("urllib.request.urlopen") as request:
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch in cached input"):
                    download("https://invalid.example/source", file, checksum)
                request.assert_not_called()
            self.assertEqual(file.read_bytes(), b"changed")

    def test_download_mismatch_never_promotes_partial_source(self):
        import io
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / "source.bin"
            with patch("urllib.request.urlopen", return_value=io.BytesIO(b"wrong")):
                with self.assertRaisesRegex(RuntimeError, "Checksum mismatch downloading"):
                    download("https://invalid.example/source", file, hashlib.sha256(b"right").hexdigest())
            self.assertFalse(file.exists())
            self.assertFalse(file.with_suffix(".bin.download").exists())


if __name__ == "__main__":
    unittest.main()
