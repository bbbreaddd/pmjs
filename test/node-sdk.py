"""Prepare a minimal verified Node SDK from a local pinned distribution archive."""
import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('node_sdk', ROOT / 'tools/linux-arm64/prepare-node.py')
node = importlib.util.module_from_spec(spec)
spec.loader.exec_module(node)


class NodeSdk(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs node sdk ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'node-fixture'
        for name in ('bin/node', 'include/node/node_api.h', 'include/node/nested/header.h',
                     'LICENSE', 'bin/npm', 'lib/node_modules/npm/index.js', 'share/doc/readme'):
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(name)
        (self.source / 'bin/node').chmod(0o755)
        self.cache = self.root / 'cache'
        self.cache.mkdir()
        self.archive = self.cache / 'node-fixture.tar.xz'
        with tarfile.open(self.archive, 'w:xz') as archive:
            archive.add(self.source, arcname=self.source.name)
        self.spec = {'artifact': self.archive.name, 'sha256': node.digest(self.archive), 'url': 'https://invalid.example/node'}
        self.output = self.root / 'sdk'

    def test_required_files_reuse_and_corruption_repair(self):
        node.prepare(self.output, self.cache, self.spec)
        record = json.loads((self.output / 'pmjs-node.json').read_text())
        self.assertEqual(set(record['files']), {'bin/node', 'include/node/node_api.h', 'include/node/nested/header.h', 'LICENSE'})
        self.assertEqual(record['source']['sha256'], node.digest(self.archive))
        original = (self.output / 'bin/node').stat().st_mtime_ns
        node.prepare(self.output, self.cache, self.spec)
        self.assertEqual((self.output / 'bin/node').stat().st_mtime_ns, original)
        (self.output / 'include/node/node_api.h').write_text('corrupt')
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            node.verify(self.output, self.spec)
        node.prepare(self.output, self.cache, self.spec)
        node.verify(self.output, self.spec)
        self.assertEqual((self.output / 'include/node/node_api.h').read_text(), 'include/node/node_api.h')

    def test_bad_download_does_not_replace_a_working_sdk(self):
        node.prepare(self.output, self.cache, self.spec)
        before = (self.output / 'pmjs-node.json').read_bytes()
        changed = {**self.spec, 'sha256': '0' * 64}
        with patch.object(node.urllib.request, 'urlopen', return_value=self.archive.open('rb')):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                node.prepare(self.output, self.cache, changed)
        self.assertEqual((self.output / 'pmjs-node.json').read_bytes(), before)
        node.verify(self.output, self.spec)


if __name__ == '__main__':
    unittest.main()
