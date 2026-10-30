"""Exercise minimal packaging with real ELF fixtures and MV/MZ inspection."""
import ctypes
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import select
import signal
import shlex
import shutil
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import Mock, patch
import zipfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import runtime_artifact as artifacts
import portmaster
from portmaster_metadata import portname_from_title


class PortMasterPackage(unittest.TestCase):
    def test_generated_portname_uses_the_shared_portmaster_rule(self):
        self.assertEqual(portname_from_title(' A Game: Test! '), 'agametest')
        with self.assertRaisesRegex(ValueError, 'valid PortMaster portname'):
            portname_from_title('...')

    def test_static_audit_rejects_bundled_firmware_graphics_libraries(self):
        library = self.stage / 'lib/libSDL2-2.0.so.0'
        shutil.copy2('/bin/true', library)
        with self.assertRaisesRegex(ValueError, 'graphics/window library must not be bundled'):
            artifacts.static_audit(self.stage, {'architecture': 'x86_64'})

    def setUp(self):
        temporary_root = ROOT / '.cache/tests'
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs package with spaces ', dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stage = self.root / 'runtime'
        (self.stage / 'bin').mkdir(parents=True)
        (self.stage / 'lib').mkdir()
        shutil.copy2('/bin/true', self.stage / 'bin/node')
        shutil.copy2(ROOT / 'bin/pmjs', self.stage / 'bin/pmjs')
        for name, source, flags in [
            ('librequired.so.1', 'int required(void) { return 42; }', []),
            ('libunused.so.1', 'int unused(void) { return 0; }', []),
            ('pmjs_native.node', 'extern int required(void); int example(void) { return required(); }',
             ['-L' + str(self.stage / 'lib'), '-l:librequired.so.1', '-Wl,-rpath,$ORIGIN'])
        ]:
            subprocess.run(['cc', '-shared', '-fPIC', '-g', '-x', 'c', '-', '-o', self.stage / 'lib' / name,
                            *flags], input=source, text=True, check=True)
        share = self.stage / 'share/pmjs'
        share.mkdir(parents=True)
        for directory in ('js', 'runner', 'profiles'):
            shutil.copytree(ROOT / directory, share / directory)
        (share / 'tools').mkdir()
        for file in ('build-js-runtime.mjs', 'build-js-composition.mjs', 'game-inspect.mjs', 'achievement-discovery.mjs', 'game-bundle.mjs',
                     'pmjs.mjs', 'package-self-test.cjs'):
            shutil.copy2(ROOT / 'tools' / file, share / 'tools' / file)
        (share / 'notices').mkdir()
        (share / 'notices/Node.LICENSE').write_text('fixture notice')
        (share / 'sources').mkdir()
        (share / 'sources/unused-source.tar.xz').write_text('not needed at runtime')
        for file in ('LICENSE', 'THIRD_PARTY_NOTICES.md'):
            shutil.copy2(ROOT / file, self.stage / file)
        self.refresh_manifest()
        self.game = self.root / 'purchased game'
        (self.game / 'js/libs').mkdir(parents=True)
        (self.game / 'data').mkdir()
        (self.game / 'data/System.json').write_text('{"gameTitle":"Minimal Game"}')
        (self.game / 'index.html').write_text('purchased bytes must not be copied')
        (self.game / 'js/rpg_core.js').write_text('Utils.RPGMAKER_VERSION = "1.6.2";')
        (self.game / 'js/rpg_managers.js').write_text('')
        (self.game / 'js/libs/pixi.js').write_text('PIXI.VERSION = "4.5.4";')
        (self.game / 'js/libs/pixi-tilemap.js').write_text('')
        (self.game / 'js/plugins.js').write_text('var $plugins = [];')
        self.output = self.root / 'output/game.zip'
        self.bundle = self.create_bundle(self.root / 'default bundle')

    def refresh_manifest(self):
        artifacts.write_json(self.stage / 'build-info.json', {'schema': 2, 'architecture': 'x86_64',
                           'buildId': 'build-package-fixture',
                           'source': {'sourceDateEpoch': 0}, 'files': artifacts.inventory(self.stage)})

    def create_bundle(self, bundle=None, config=None, adapters=()):
        bundle = bundle or self.root / 'portable bundle'
        subprocess.run(['node', ROOT / 'tools/game-bundle.mjs', self.game, bundle, config or '', '', *adapters],
                       check=True, capture_output=True)
        return bundle

    def test_minimal_contents_and_stripping(self):
        # Legacy/general installations may include development material and provenance.
        for name in ('share/pmjs/docs/guide.md', 'share/pmjs/tools/portmaster.py',
                     'share/pmjs/tools/release.py', 'share/pmjs/tools/linux-arm64/audit-abi.py', 'src/runtime.cpp'):
            file = self.stage / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('host-only material')
        self.refresh_manifest()
        info = json.loads((self.stage / 'build-info.json').read_text())
        info.update(compiledInputs={'files': {'host/source.cpp': 'hash'}}, environment={'recipe': 'host'},
                    loader={'host': 'audit'})
        info['source']['files'] = {'host/source.cpp': 'hash'}
        artifacts.write_json(self.stage / 'build-info.json', info)
        original = artifacts.inventory(self.stage)
        portmaster.portmaster(self.stage, self.bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            self.assertIsNone(package.testzip())
            names = package.namelist()
            self.assertIn('Minimal Game.sh', names)
            self.assertIn('minimalgame/gamedata/', names)
            self.assertTrue(any(name.startswith('minimalgame/runtime/') for name in names))
            self.assertNotIn('minimal-game/', '\n'.join(names))
            self.assertNotIn('minimalgame/minimalgame.ini', names)
            self.assertIn('minimalgame/runtime/lib/librequired.so.1', names)
            self.assertNotIn('minimalgame/runtime.squashfs', names)
            licenses = package.read('minimalgame/runtime/LICENSES.txt').decode()
            self.assertIn('Node.LICENSE', licenses)
            self.assertIn('fixture notice', licenses)
            self.assertFalse(any('libunused' in name or '/sources/' in name
                                 for name in names))
            self.assertIn('minimalgame/pmjs.json', names)
            self.assertIn('minimalgame/runtime/share/pmjs/tools/pmjs.mjs', names)
            self.assertIn('minimalgame/runtime/build-info.json', names)
            packaged_info = json.loads(package.read('minimalgame/runtime/build-info.json'))
            self.assertEqual(packaged_info['buildId'], 'build-package-fixture')
            for key in ('compiledInputs', 'environment', 'loader'):
                self.assertNotIn(key, packaged_info)
            self.assertNotIn('files', packaged_info['source'])
            self.assertFalse(any('/docs/' in name or '/src/' in name or name.endswith('.py') for name in names))
            expected_runtime_files = {name.removeprefix('minimalgame/runtime/') for name in names
                                      if name.startswith('minimalgame/runtime/') and not name.endswith('/')
                                      and name != 'minimalgame/runtime/build-info.json'}
            self.assertNotIn('files', packaged_info)
            runtime_files = {name: {'sha256': hashlib.sha256(package.read('minimalgame/runtime/' + name)).hexdigest(),
                                    'bytes': len(package.read('minimalgame/runtime/' + name))}
                             for name in expected_runtime_files}
            self.assertEqual(packaged_info['payloadSha256'], artifacts.payload_digest(runtime_files))
            self.assertEqual([name for name in names if '/gamedata/' in name], ['minimalgame/gamedata/'])
            self.assertEqual(package.getinfo('Minimal Game.sh').external_attr >> 16 & 0o777, 0o755)
            binary = self.root / 'pmjs_native.node'
            binary.write_bytes(package.read('minimalgame/runtime/lib/pmjs_native.node'))
            (self.root / 'librequired.so.1').write_bytes(package.read('minimalgame/runtime/lib/librequired.so.1'))
            sections = subprocess.check_output(['readelf', '-S', '--wide', binary], text=True)
            self.assertNotIn('.debug', sections)
            self.assertNotIn('.symtab', sections)
            self.assertEqual(ctypes.CDLL(str(binary)).example(), 42, 'stripped code and dependency load')
        self.assertEqual(artifacts.inventory(self.stage), original)
        self.assertEqual(list(self.output.parent.iterdir()), [self.output], 'one ZIP, no companion files')
        checksum = artifacts.digest(self.output)
        portmaster.portmaster(self.stage, self.bundle, self.output)
        self.assertEqual(artifacts.digest(self.output), checksum, 'deterministic ZIP')
        with self.assertRaisesRegex(ValueError, 'valid PortMaster portname'):
            portmaster.portmaster(self.stage, self.bundle, self.output, name='---')

    def test_submission_metadata_and_licenses(self):
        import struct
        import zlib
        submission = self.root / 'minimalgame'
        submission.mkdir()
        raw = b''.join(b'\x00' + b'\0' * (640 * 4) for _ in range(480))
        def chunk(kind, data):
            content = kind + data
            return struct.pack('>I', len(data)) + content + struct.pack('>I', zlib.crc32(content))
        (submission / 'screenshot.png').write_bytes(
            b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 640, 480, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
        (submission / 'README.md').write_text('## Notes\n\nThanks to the developer — and contributors.\n\n## Controls\n\n## Compile\n')
        (submission / 'gameinfo.xml').write_text('''<?xml version="1.0"?>
<gameList><game><path>./Minimal Game.sh</path><name>Minimal Game</name>
<desc>A game — with punctuation.</desc><releasedate>20060606T000000</releasedate>
<developer>Example Developer</developer><publisher>Open Source</publisher><genre>RPG</genre>
<image>./minimalgame/screenshot.png</image></game></gameList>''')
        descriptor = {'version': 4, 'name': 'minimalgame.zip',
                      'items': ['Minimal Game.sh', 'minimalgame'], 'items_opt': [],
                      'attr': {'title': 'Minimal Game — Subtitle', 'porter': ['Test Porter'],
                               'desc': 'A game — and test', 'desc_md': 'A game — and test',
                               'inst': 'Supply the game files.', 'inst_md': None,
                               'genres': ['rpg'], 'image': None, 'rtr': False,
                               'exp': False, 'runtime': [], 'arch': ['x86_64'], 'store': [],
                               'availability': 'full', 'reqs': [], 'min_glibc': ''}}
        (submission / 'port.json').write_text(json.dumps(descriptor))
        (submission / 'testing_thread.txt').write_text('Testing instructions')
        (submission / 'patches').mkdir()
        (submission / 'patches/build.sh').write_text('#!/bin/sh\necho build\n')
        output = self.root / 'output/minimalgame.zip'
        subprocess.run(['node', ROOT / 'test/helpers/generate-schema3-index.cjs',
                         self.bundle, self.game, self.root], check=True, capture_output=True, text=True)
        index = json.loads((self.bundle / 'asset-index.json').read_text())
        self.assertEqual(index['schema'], 3, 'integration package uses a generated schema 3 asset index')
        self.assertIsInstance(index['images'], list)
        self.assertEqual(len(index['images']), 1)
        self.assertEqual(index['images'][0]['calculated']['outputs'][0]['path'],
                         'assets/images/prepared-image/page.png')
        portmaster.portmaster(self.stage, self.bundle, output, submission=submission, release=True)
        with zipfile.ZipFile(output) as package:
            self.assertIsNone(package.testzip())
            names = package.namelist()
            for name in ('port.json', 'README.md', 'gameinfo.xml', 'screenshot.png'):
                self.assertIn('minimalgame/' + name, names)
            self.assertEqual({name.split('/')[0] for name in names},
                             {'Minimal Game.sh', 'minimalgame'})
            self.assertIn('minimalgame/testing_thread.txt', names)
            self.assertIn('minimalgame/patches/build.sh', names)
            self.assertIn('minimalgame/gamedata/', names)
            self.assertIn('Minimal Game.sh', names)
            self.assertNotIn('minimalgame/runtime/LICENSES.txt', names)
            self.assertIn('minimalgame/licenses/LICENSE.share_pmjs_notices_node_license.txt', names)
            self.assertIn('minimalgame/licenses/LICENSE.license.txt', names)
            self.assertEqual(json.loads(package.read('minimalgame/port.json')), descriptor)
            self.assertEqual(package.read('minimalgame/gameinfo.xml'),
                             (submission / 'gameinfo.xml').read_bytes())
            self.assertNotIn('minimalgame/minimalgame.md', names)
            self.assertEqual(package.read('minimalgame/assets/images/prepared-image/page.png'),
                             b'generated image page')
            self.assertNotIn(b'purchased bytes', b''.join(package.read(n) for n in names if n.endswith('.js')))
        checksum = artifacts.digest(output)
        portmaster.portmaster(self.stage, self.bundle, output, submission=submission, release=True)
        self.assertEqual(artifacts.digest(output), checksum)
        portmaster.portmaster(self.stage, self.bundle, output, submission=submission, layout='pr')
        with zipfile.ZipFile(output) as package:
            names = package.namelist()
            for name in ('port.json', 'README.md', 'gameinfo.xml', 'screenshot.png',
                         'testing_thread.txt', 'patches/build.sh'):
                self.assertIn(name, names)
                self.assertNotIn('minimalgame/' + name, names)
            self.assertEqual(package.read('gameinfo.xml'), (submission / 'gameinfo.xml').read_bytes())
            self.assertIn('minimalgame/licenses/LICENSE.license.txt', names)
        checksum = artifacts.digest(output)
        descriptor['attr']['arch'] = ['armhf']
        (submission / 'port.json').write_text(json.dumps(descriptor))
        with self.assertRaisesRegex(ValueError, 'architecture'):
            portmaster.portmaster(self.stage, self.bundle, output, submission=submission, release=True)
        self.assertEqual(artifacts.digest(output), checksum, 'invalid input must not replace existing package')
        descriptor['attr']['arch'] = ['x86_64']
        descriptor['items'][0] = 'Different.sh'
        (submission / 'port.json').write_text(json.dumps(descriptor))
        with self.assertRaisesRegex(ValueError, 'launcher'):
            portmaster.portmaster(self.stage, self.bundle, output, submission=submission, release=True)

    def test_release_mode_requires_authored_submission(self):
        with self.assertRaisesRegex(ValueError, 'requires --submission'):
            portmaster.portmaster(self.stage, self.bundle, self.output, release=True)
        self.assertFalse(self.output.exists())

    def test_layout_validation_preserves_existing_output(self):
        self.output.parent.mkdir(parents=True, exist_ok=True)
        self.output.write_bytes(b'existing archive')
        for layout, message in (('other', 'layout'), ('pr', 'requires --submission')):
            with self.subTest(layout=layout), self.assertRaisesRegex(ValueError, message):
                portmaster.portmaster(self.stage, self.bundle, self.output, layout=layout)
            self.assertEqual(self.output.read_bytes(), b'existing archive')

    def test_adapter_configuration_and_mz(self):
        adapter = self.root / 'adapter.js'
        adapter.write_text('globalThis.adapterRegistered = true;')
        config = self.root / 'config.json'
        config.write_text('{"display":{"width":960,"height":720}}')
        for engine in ('mv', 'mz'):
            if engine == 'mz':
                (self.game / 'js/rpg_core.js').unlink()
                (self.game / 'js/rmmz_core.js').write_text('Utils.RPGMAKER_VERSION = "1.10.0";')
                (self.game / 'js/libs/pixi.js').write_text('PIXI.VERSION = "5.3.12";')
            bundle = self.create_bundle(self.root / (engine + " bundle"), config=config, adapters=[adapter])
            portmaster.portmaster(self.stage, bundle, self.output)
            with zipfile.ZipFile(self.output) as package:
                bundle = package.read('minimalgame/bootstrap.js').decode()
                self.assertLess(bundle.index('adapterRegistered'), bundle.index(f'// BEGIN js/pmjs-{engine}/bootstrap.js'))
                self.assertEqual(package.read('minimalgame/config.json'), config.read_bytes())

    def test_failure_preserves_existing_zip(self):
        self.output.parent.mkdir()
        self.output.write_bytes(b'existing package')
        with self.assertRaises(subprocess.CalledProcessError):
            portmaster.portmaster(self.stage, self.bundle, self.output, strip='/bin/false')
        self.assertEqual(self.output.read_bytes(), b'existing package')
        write_zip = portmaster.write_zip

        def failed_archive(directory, output, epoch):
            with patch('portmaster.shutil.copyfileobj', side_effect=OSError('archive write failed')):
                write_zip(directory, output, epoch)

        with patch('portmaster.write_zip', side_effect=failed_archive):
            with self.assertRaisesRegex(OSError, 'archive write failed'):
                portmaster.portmaster(self.stage, self.bundle, self.output)
        self.assertEqual(self.output.read_bytes(), b'existing package')
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_stripped_closure_needs_no_strip_tool(self):
        selected = ('bin/node', 'lib/pmjs_native.node', 'lib/librequired.so.1')
        for name in selected:
            artifacts.strip_binary(self.stage / name, 'strip')
        self.refresh_manifest()
        original = artifacts.inventory(self.stage)
        self.assertTrue(artifacts.elf(self.stage / 'lib/libunused.so.1', stripping=True)['needsStrip'])
        with patch('portmaster.shutil.which', return_value=None):
            portmaster.portmaster(self.stage, self.bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            for name in selected:
                self.assertEqual(package.read('minimalgame/runtime/' + name), (self.stage / name).read_bytes())
        self.assertEqual(artifacts.inventory(self.stage), original)

    def test_unstripped_closure_requires_a_strip_tool(self):
        with patch('portmaster.shutil.which', return_value=None):
            with self.assertRaisesRegex(ValueError, 'specify --strip'):
                portmaster.portmaster(self.stage, self.bundle, self.output)
        self.assertFalse(self.output.exists())

    def test_strip_cannot_change_symbols_or_loader_information(self):
        original = artifacts.inventory(self.stage)
        tool = self.root / 'corrupt-strip'
        self.output.parent.mkdir()
        self.output.write_bytes(b'existing package')
        for old, new in ((b'required', b'changed_'), (b'$ORIGIN', b'$BROKEN')):
            with self.subTest(value=old):
                tool.write_text(f'#!{sys.executable}\nfrom pathlib import Path\nimport sys\n'
                                f'file = Path(sys.argv[-1])\n'
                                f'file.write_bytes(file.read_bytes().replace({old!r}, {new!r}))\n')
                tool.chmod(0o755)
                with self.assertRaisesRegex(ValueError, 'changed dynamic symbols or loader information'):
                    portmaster.portmaster(self.stage, self.bundle, self.output, strip=tool)
                self.assertEqual(self.output.read_bytes(), b'existing package')
        self.assertEqual(artifacts.inventory(self.stage), original)

    def test_separate_media_source_download_is_preserved(self):
        shutil.copy2(self.stage / 'lib/librequired.so.1', self.stage / 'lib/libavutil.so.58')
        subprocess.run(['cc', '-shared', '-fPIC', '-x', 'c', '-', '-o', self.stage / 'lib/pmjs_native.node',
                        '-L' + str(self.stage / 'lib'), '-l:libavutil.so.58', '-Wl,-rpath,$ORIGIN'],
                       input='extern int required(void); int example(void) { return required(); }',
                       text=True, check=True)
        self.refresh_manifest()
        info = json.loads((self.stage / 'build-info.json').read_text())
        info['dependencySources'] = {'filename': 'pmjs-ffmpeg-sources-1234567.tar.gz', 'sha256': 'a' * 64,
                                    'url': 'https://example.invalid/releases/download/build/source.tar.gz'}
        artifacts.write_json(self.stage / 'build-info.json', info)
        portmaster.portmaster(self.stage, self.bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            packaged_info = json.loads(package.read('minimalgame/runtime/build-info.json'))
            self.assertEqual(packaged_info['dependencySources'], info['dependencySources'])
            self.assertIn(info['dependencySources']['url'], package.read('minimalgame/runtime/LICENSES.txt').decode())
            self.assertIn('minimalgame/runtime/lib/libavutil.so.58', package.namelist())
            self.assertFalse(any('/sources/' in name for name in package.namelist()))

    def test_explicit_source_archive_is_verified_and_not_embedded(self):
        archive = self.root / 'ffmpeg-sources.tar.gz'
        source = b'matching source code'
        recipe = {'url': 'https://example.invalid/ffmpeg-fixture.tar.xz',
                  'sha256': hashlib.sha256(source).hexdigest()}
        materials = {'ffmpeg-ffmpeg-fixture.tar.xz': source,
                     'build-records/ffmpeg.json': json.dumps({'recipe': {'source': recipe}}).encode(),
                     'tools/linux-arm64/sdk-recipes.json': json.dumps({'sources': {'ffmpeg': recipe}}).encode()}
        for name in ('build-records/toolchain.json', 'build-records/sysroot.json',
                     'tools/linux-arm64/prepare-sdk.py',
                     'cmake/toolchains/portable-arm64.cmake'):
            materials[name] = b'fixture rebuild material'
        materials['tools/linux-arm64/sdk-packages.json'] = b'{}'
        def write_archive():
            with tarfile.open(archive, 'w:gz') as output:
                for name, data in materials.items():
                    entry = tarfile.TarInfo('pmjs-ffmpeg-sources/' + name)
                    entry.size = len(data)
                    output.addfile(entry, io.BytesIO(data))
        write_archive()
        kwargs = {'sources': archive, 'sources_url': 'https://example.invalid/ffmpeg-sources.tar.gz'}
        portmaster.portmaster(self.stage, self.bundle, self.output, **kwargs)
        with zipfile.ZipFile(self.output) as package:
            info = json.loads(package.read('minimalgame/runtime/build-info.json'))
            self.assertEqual(info['dependencySources']['sha256'], artifacts.digest(archive))
            self.assertFalse(any('/sources/' in name or name.endswith('.tar.gz') for name in package.namelist()))
        portmaster.portmaster(self.stage, self.bundle, self.output, sources=archive)
        with zipfile.ZipFile(self.output) as package:
            info = json.loads(package.read('minimalgame/runtime/build-info.json'))
            self.assertEqual(info['dependencySources'],
                             {'filename': archive.name, 'sha256': artifacts.digest(archive)})
            self.assertIn(archive.name, package.read('minimalgame/runtime/LICENSES.txt').decode())
        before = self.output.read_bytes()
        materials['ffmpeg-ffmpeg-fixture.tar.xz'] = b'wrong source code'
        write_archive()
        with self.assertRaisesRegex(ValueError, 'source checksum'):
            portmaster.portmaster(self.stage, self.bundle, self.output, **kwargs)
        archive.write_bytes(b'invalid archive')
        with self.assertRaisesRegex(ValueError, 'Invalid FFmpeg source archive'):
            portmaster.portmaster(self.stage, self.bundle, self.output, **kwargs)
        self.assertEqual(self.output.read_bytes(), before)

    def test_bundle_rejects_extra_files_and_carries_declared_generated_pages(self):
        bundle = self.create_bundle()
        extra = bundle / 'unexpected-game-file.png'
        extra.write_bytes(b'not declared')
        with self.assertRaisesRegex(ValueError, 'undeclared files'):
            portmaster.portmaster(self.stage, bundle, self.output)
        self.assertFalse(self.output.exists())
        extra.unlink()
        page = 'assets/images/' + 'a' * 64 + '/page-0.png'
        target = bundle / page
        target.parent.mkdir(parents=True)
        target.write_bytes(b'generated page fixture')
        index = {'schema': 1, 'kind': 'pmjs-asset-index',
                 'images': [{'outputs': [{'path': page,
                                          'hash': hashlib.sha256(target.read_bytes()).hexdigest()}]}],
                 'maps': None}
        index_file = bundle / 'asset-index.json'
        index_file.write_text(json.dumps(index))
        descriptor_file = bundle / 'pmjs.json'
        descriptor = json.loads(descriptor_file.read_text())
        descriptor.update(assetIndex='asset-index.json',
                          assetIndexSha256=hashlib.sha256(index_file.read_bytes()).hexdigest(),
                          assets='assets')
        descriptor_file.write_text(json.dumps(descriptor))
        portmaster.portmaster(self.stage, bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            self.assertEqual(package.read('minimalgame/' + page), target.read_bytes())
        target.write_bytes(b'corrupt generated page')
        checksum = artifacts.digest(self.output)
        with self.assertRaisesRegex(ValueError, 'Generated asset checksum'):
            portmaster.portmaster(self.stage, bundle, self.output)
        self.assertEqual(artifacts.digest(self.output), checksum)

    def test_bundle_rejects_traversal_and_checksum_mismatches(self):
        bundle = self.create_bundle()
        file = bundle / 'pmjs.json'
        descriptor = json.loads(file.read_text())
        for key, value, message in (('bootstrap', '../outside.js', 'Invalid path'),
                                    ('bootstrapSha256', '0' * 64, 'bootstrap checksum')):
            with self.subTest(key=key):
                file.write_text(json.dumps({**descriptor, key: value}))
                with self.assertRaisesRegex(ValueError, message):
                    portmaster.portmaster(self.stage, bundle, self.output)
                self.assertFalse(self.output.exists())

    def test_bundle_preserves_nested_helpers_from_the_preparation_producer(self):
        processor = self.root / 'nested.pmjs-processor.cjs'
        processor.write_text("module.exports = { id: 'nested', version: 1, files: ['lib/helper.cjs'], outputs: [{ id: 'fixture', source: 'data/System.json', generate(bytes) { return require('./lib/helper.cjs')(bytes); } }] };")
        helper = self.root / 'lib/helper.cjs'
        helper.parent.mkdir()
        helper.write_text("module.exports = bytes => bytes;")
        subprocess.run(['node', '-e', """
const fs = require('node:fs');
const path = require('node:path');
const { buildPortPreparation, verifyPortDescriptor } = require('./runner/port-preparation.cjs');
const [bundleRoot, processor] = process.argv.slice(1);
const file = path.join(bundleRoot, 'pmjs.json');
const descriptor = JSON.parse(fs.readFileSync(file));
descriptor.portPreparation = buildPortPreparation({ bundleRoot, processors: [processor] });
verifyPortDescriptor(bundleRoot, descriptor.portPreparation);
fs.writeFileSync(file, JSON.stringify(descriptor));
""", self.bundle, processor], cwd=ROOT, check=True, capture_output=True, text=True)
        before = json.loads((self.bundle / 'pmjs.json').read_text())
        self.assertEqual(portmaster.checked_bundle(self.bundle)['portPreparation'], before['portPreparation'])
        portmaster.portmaster(self.stage, self.bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            self.assertEqual(package.read('minimalgame/preparation/nested/lib/helper.cjs'), helper.read_bytes())

    def test_bundle_refreshes_stale_preparation_manifest_from_sidecars(self):
        bundle = self.root / 'stale-preparation-bundle'
        shutil.copytree(self.bundle, bundle)
        processor_dir = bundle / 'preparation' / 'fixture-processor'
        processor_dir.mkdir(parents=True)
        processor = processor_dir / 'fixture-processor.pmjs-processor.cjs'
        processor.write_text('module.exports = {};')
        stale_output = bundle / 'assets/ports/fixture-processor/old.pma1'
        stale_output.parent.mkdir(parents=True)
        stale_output.write_bytes(b'old generated output')
        descriptor_path = bundle / 'pmjs.json'
        descriptor = json.loads(descriptor_path.read_text())
        descriptor['portPreparation'] = [{'id': 'removed-processor'}]
        descriptor_path.write_text(json.dumps(descriptor))

        refreshed = portmaster.checked_bundle(bundle)

        self.assertEqual([item['id'] for item in refreshed['portPreparation']], ['fixture-processor'])
        self.assertEqual(refreshed['portPreparation'][0]['outputs'], [])
        self.assertFalse(stale_output.exists())

    def test_bundle_rejects_symlinks_before_reading_descriptor(self):
        bundle = self.create_bundle()
        for name in ('pmjs.json', 'bootstrap.js', 'gamedata'):
            with self.subTest(name=name):
                file = bundle / name
                saved = self.root / ('saved-' + name)
                original = file.read_bytes() if file.is_file() else None
                file.rename(saved)
                file.symlink_to(saved)
                try:
                    # A descriptor link must be rejected without parsing its target.
                    if name == 'pmjs.json':
                        saved.write_text('not JSON')
                    with self.assertRaisesRegex(ValueError, 'symbolic links'):
                        portmaster.portmaster(self.stage, bundle, self.output)
                    self.assertFalse(self.output.exists())
                finally:
                    file.unlink()
                    if original is not None:
                        saved.write_bytes(original)
                    saved.rename(file)

    def test_bundle_is_validated_after_copy_and_published_from_that_copy(self):
        bundle = self.create_bundle()
        bootstrap = bundle / 'bootstrap.js'
        original = bootstrap.read_bytes()
        copytree = shutil.copytree

        def corrupt_copy(source, destination, *args, **kwargs):
            result = copytree(source, destination, *args, **kwargs)
            if source == bundle:
                (destination / 'bootstrap.js').write_bytes(b'corrupt staged bootstrap')
            return result

        with patch('portmaster.shutil.copytree', side_effect=corrupt_copy):
            with self.assertRaisesRegex(ValueError, 'bootstrap checksum'):
                portmaster.portmaster(self.stage, bundle, self.output)
        self.assertFalse(self.output.exists())

        def change_source(source, destination, *args, **kwargs):
            result = copytree(source, destination, *args, **kwargs)
            if source == bundle:
                bootstrap.write_bytes(b'changed after copy')
            return result

        with patch('portmaster.shutil.copytree', side_effect=change_source):
            portmaster.portmaster(self.stage, bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            self.assertEqual(package.read('minimalgame/bootstrap.js'), original)

    def test_package_cli_delegates_bundle_validation_to_python(self):
        bundle = self.create_bundle()
        # The CLI prefix needs its own packager; the minimal target fixture omits it.
        for name in ('portmaster.py', 'portmaster_metadata.py', 'runtime_artifact.py'):
            shutil.copy2(ROOT / 'tools' / name, self.stage / 'share/pmjs/tools' / name)
        self.refresh_manifest()
        info = json.loads((self.stage / 'build-info.json').read_text())
        info.update(source={**info['source'], 'commit': '0' * 40})
        artifacts.write_json(self.stage / 'build-info.json', info)
        command = ['node', self.stage / 'share/pmjs/tools/pmjs.mjs', self.stage, 'package', bundle,
                   '--runtime', self.stage, '--output', self.output]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        checksum = artifacts.digest(self.output)
        result = subprocess.run(command + ['--layout', 'testing'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(artifacts.digest(self.output), checksum)
        result = subprocess.run(command + ['--layout', 'pr'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('PR layout requires --submission', result.stderr)
        self.assertEqual(artifacts.digest(self.output), checksum)
        (bundle / 'bootstrap.js').write_text('corrupt bootstrap')
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Bundle bootstrap checksum differs', result.stderr)
        self.assertIn('packaging failed', result.stderr)
        self.assertEqual(artifacts.digest(self.output), checksum)
        result = subprocess.run(command[:3] + [bundle, '--game', self.game, '--state', self.root / 'state'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('bundle bootstrap checksum differs', result.stderr)
        self.assertNotIn('packaging failed', result.stderr)

    def test_zip_streams_contents_and_preserves_metadata(self):
        payload = self.root / 'payload'
        payload.mkdir()
        (payload / 'empty').mkdir()
        file = payload / 'large.bin'
        content = b'large ZIP entry\x00' * (256 * 1024)
        file.write_bytes(content)
        file.chmod(0o755)
        archive = self.root / 'streamed.zip'
        open_file = Path.open

        @contextmanager
        def bounded_open(path, *args, **kwargs):
            with open_file(path, *args, **kwargs) as stream:
                if path == file:
                    def read(size=-1):
                        self.assertGreater(size, 0, 'ZIP reads must be bounded')
                        self.assertLessEqual(size, 1024 * 1024)
                        return stream.read(size)
                    reader = Mock(wraps=stream)
                    reader.read.side_effect = read
                    yield reader
                else:
                    yield stream

        # Exercise ZIP64 headers without allocating a multi-gigabyte fixture.
        for limit in (zipfile.ZIP64_LIMIT, 1024 * 1024):
            with self.subTest(zip64_limit=limit), patch.object(zipfile, 'ZIP64_LIMIT', limit):
                with patch.object(Path, 'open', bounded_open):
                    portmaster.write_zip(payload, archive, 0)
                with zipfile.ZipFile(archive) as package:
                    self.assertIsNone(package.testzip())
                    self.assertEqual(package.namelist(), ['empty/', 'large.bin'])
                    self.assertEqual(package.read('large.bin'), content)
                    for name in package.namelist():
                        entry = package.getinfo(name)
                        self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                        self.assertEqual(entry.external_attr >> 16 & 0o777, 0o755)
                        self.assertEqual(entry.compress_type, zipfile.ZIP_DEFLATED)
                checksum = artifacts.digest(archive)
                os.utime(file, (1700000000, 1700000000))
                portmaster.write_zip(payload, archive, 0)
                self.assertEqual(artifacts.digest(archive), checksum)

    def test_plain_runtime_can_be_packaged_without_release_qualification(self):
        info = json.loads((self.stage / 'build-info.json').read_text())
        del info['files']
        artifacts.write_json(self.stage / 'build-info.json', info)
        portmaster.portmaster(self.stage, self.bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            packaged = json.loads(package.read('minimalgame/runtime/build-info.json'))
            self.assertTrue(packaged['payloadSha256'])
            self.assertNotIn('files', packaged)
            self.assertNotIn('compiledInputs', packaged)
        result = subprocess.run(['python3', ROOT / 'tools/portmaster.py', '--stage', self.stage,
                                 '--game', self.game, '--output', self.output], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        # Plain input still has to supply every selected runtime tool.
        (self.stage / 'share/pmjs/tools/game-inspect.mjs').unlink()
        before = self.output.read_bytes()
        with self.assertRaises(FileNotFoundError):
            portmaster.portmaster(self.stage, self.bundle, self.output)
        self.assertEqual(self.output.read_bytes(), before)

    def test_release_mode_requires_authored_submission(self):
        with self.assertRaisesRegex(ValueError, 'requires --submission'):
            portmaster.portmaster(self.stage, self.bundle, self.output, release=True)
        self.assertFalse(self.output.exists())

    def test_legacy_runtime_keeps_its_diagnostic_inventory(self):
        info = json.loads((self.stage / 'build-info.json').read_text())
        info['schema'] = 1
        info['payloadSha256'] = artifacts.payload_digest(artifacts.inventory(self.stage))
        info['compiledInputs'] = {'host': 'detail'}
        artifacts.write_json(self.stage / 'build-info.json', info)
        portmaster.portmaster(self.stage, self.bundle, self.output)
        with zipfile.ZipFile(self.output) as package:
            info = json.loads(package.read('minimalgame/runtime/build-info.json'))
            self.assertEqual(info['schema'], 1)
            self.assertNotIn('payloadSha256', info)
            self.assertTrue(info['files'])
            self.assertNotIn('compiledInputs', info)

    def test_wrong_strip_tool_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'left debug information'):
            portmaster.portmaster(self.stage, self.bundle, self.output, strip='/bin/true')
        self.assertFalse(self.output.exists())

    def test_unbundled_node_and_changed_runtime_are_rejected(self):
        (self.stage / 'bin/node').unlink()
        self.refresh_manifest()
        with self.assertRaisesRegex(ValueError, 'bundled target Node'):
            portmaster.portmaster(self.stage, self.bundle, self.output)
        (self.stage / 'LICENSE').write_text('changed')
        self.assertEqual(artifacts.recognize_runtime(self.stage)['schema'], 2,
                         'recognition does not claim payload integrity')
        with self.assertRaisesRegex(ValueError, 'differ from build-info'):
            portmaster.portmaster(self.stage, self.bundle, self.output)

    def test_output_and_name_cannot_escape(self):
        with self.assertRaisesRegex(ValueError, 'outside'):
            portmaster.portmaster(self.stage, self.bundle, self.bundle / 'game.zip')
        with self.assertRaisesRegex(ValueError, 'path separators'):
            portmaster.portmaster(self.stage, self.bundle, self.output, name='../escape')


class PortMasterLauncher(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs firmware with spaces ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.control = self.root / 'PortMaster'
        self.control.mkdir()
        self.port = self.root / 'storage/ports/minimalgame'
        (self.port / 'gamedata').mkdir(parents=True)
        (self.port / 'gamedata/index.html').touch()
        (self.port / 'saves').mkdir()
        (self.port / 'saves/existing.rpgsave').write_text('existing progress')
        (self.port / 'runtime/bin').mkdir(parents=True)
        self.launcher = self.root / 'menu/Minimal Game.sh'
        self.launcher.parent.mkdir()
        launcher = portmaster.PORTMASTER_LAUNCHER.replace('@ID@', 'minimalgame')
        for location in ('/opt/system/Tools/PortMaster', '/opt/tools/PortMaster', '/roms/ports/PortMaster'):
            launcher = launcher.replace(location, str(self.root / location.lstrip('/')))
        self.launcher.write_text(launcher)
        self.events = self.root / 'events.txt'
        self.capture = self.root / 'node.json'
        self.gpt_capture = self.root / 'gptokeyb2.json'
        node = self.port / 'runtime/bin/node'
        node.write_text('#!' + sys.executable + '\n' + '''import json, os, signal, sys, time
from pathlib import Path
Path(os.environ['CAPTURE']).write_text(json.dumps({
    'argv': sys.argv[1:], 'env': dict(os.environ), 'pid': os.getpid(), 'uid': os.getuid()
}))
if 'READY_FD' in os.environ:
    if os.environ.get('IGNORE_TERM') == '1':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.write(int(os.environ['READY_FD']), b'1')
    signal.pause()
time.sleep(0.05)
sys.exit(int(os.environ.get('NODE_STATUS', '0')))
''')
        node.chmod(0o755)
        helpers = self.root / 'helpers'
        helpers.mkdir()
        gptokeyb = helpers / 'gptokeyb2'
        gptokeyb.write_text('#!' + sys.executable + '\n' + '''import json, os, signal, sys
from pathlib import Path
Path(os.environ['GPT_CAPTURE']).write_text(json.dumps({
    'argv': sys.argv[1:], 'wrapper': os.environ.get('HELPER_WRAPPER')
}))
if 'KILL_TARGET_FD' in os.environ:
    target = int(os.read(int(os.environ['KILL_TARGET_FD']), 32))
    os.kill(target, signal.SIGKILL)
''')
        gptokeyb.chmod(0o755)
        shutil.copy2(ROOT / 'bin/pmjs', self.port / 'runtime/bin/pmjs')
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('SDL_', 'PMJS_', 'PORTMASTER_')) and
                    key not in ('controlfolder', 'directory', 'HOTKEY', 'LD_LIBRARY_PATH')}
        self.env.update(XDG_DATA_HOME=str(self.root), EVENTS=str(self.events),
                        CAPTURE=str(self.capture), GPT_CAPTURE=str(self.gpt_capture), CFW_NAME='fixture',
                        GPTOKEYB2='env HELPER_WRAPPER=active gptokeyb2',
                        PATH=str(helpers) + os.pathsep + os.environ['PATH'])
        (self.control / 'control.txt').write_text('export directory=' +
            shlex.quote(str(self.root / 'storage').lstrip('/')) + '\n' + r'''
[ -z "${DIRECTORY_OVERRIDE:-}" ] || directory="$DIRECTORY_OVERRIDE"
export LD_LIBRARY_PATH=/firmware/lib
get_controls() {
  sdl_controllerconfig=firmware-map
  export SDL_GAMECONTROLLERCONFIG_FILE="$controlfolder/gamecontrollerdb.txt"
  HOTKEY=${FIRMWARE_HOTKEY:-}
  return "${CONTROLS_STATUS:-0}"
}
pm_platform_helper() { echo base-helper >> "$EVENTS"; }
pm_finish() {
  printf 'finish:%s\n' "$LD_LIBRARY_PATH" >> "$EVENTS"
  return "${FINISH_STATUS:-0}"
}
return "${CONTROL_STATUS:-0}"
''')
        self.module = r'''
export MODULE_LOADED=1
pm_platform_helper() {
  printf 'platform:%s\n' "$1" >> "$EVENTS"
  return "${PLATFORM_STATUS:-0}"
}
return "${MODULE_STATUS:-0}"
'''
        (self.control / 'mod_fixture.txt').write_text(self.module)

    def run_launcher(self, expect_finish=True, **values):
        self.events.unlink(missing_ok=True)
        self.capture.unlink(missing_ok=True)
        self.gpt_capture.unlink(missing_ok=True)
        result = subprocess.run(['bash', self.launcher], env={**self.env, **values},
                                capture_output=True, text=True, timeout=5)
        events = self.events.read_text().splitlines() if self.events.exists() else []
        self.assertEqual(events.count('finish:/firmware/lib'), int(expect_finish), events)
        self.assertEqual((self.port / 'saves/existing.rpgsave').read_text(), 'existing progress')
        return result

    def test_firmware_modules_paths_and_inherited_settings(self):
        inherited = {'WAYLAND_DISPLAY': 'wayland-custom', 'DISPLAY': ':7',
                     'XDG_RUNTIME_DIR': '/run/user/1002', 'SWAYSOCK': '/run/custom-sway.sock',
                     'SDL_VIDEODRIVER': 'firmware-backend', 'SDL_VIDEO_EGL_DRIVER': '/firmware/egl.so',
                     'SDL_VIDEO_GL_DRIVER': '/firmware/gles.so', 'SDL_AUDIODRIVER': 'pipewire',
                     'SDL_ROTATION': '90', 'SDL_BLITTER_DISABLED': '0',
                     'SDL_KMSDRM_REQUIRE_DRM_MASTER': '0'}
        for firmware in ('muOS', 'ROCKNIX', 'knulli', 'dArkOS', 'AmberELEC', 'ArkOS'):
            with self.subTest(firmware=firmware):
                (self.control / f'mod_{firmware}.txt').write_text(self.module)
                result = self.run_launcher(CFW_NAME=firmware,
                                           SDL_GAMECONTROLLERCONFIG='custom-map', **inherited)
                self.assertEqual(result.returncode, 0, result.stderr)
                capture = json.loads(self.capture.read_text())
                self.assertEqual(capture['uid'], os.getuid(), 'frontend identity is preserved')
                for name, value in inherited.items():
                    self.assertEqual(capture['env'][name], value)
                self.assertEqual(capture['env']['SDL_GAMECONTROLLERCONFIG'], 'firmware-map')
                self.assertEqual(capture['env']['MODULE_LOADED'], '1')
                self.assertEqual(capture['env']['LD_LIBRARY_PATH'], str(self.port / 'runtime/lib') + ':/firmware/lib')
                self.assertEqual(capture['env']['SDL_GAMECONTROLLERCONFIG_FILE'], str(self.control / 'gamecontrollerdb.txt'))
                self.assertIn('platform:' + str(self.port / 'runtime/bin/node'), self.events.read_text())
                self.assertIn(str(self.port), capture['argv'])
                self.assertIn(str(self.port / 'saves'), capture['argv'])
                self.assertIn(str(self.port / '.cache'), capture['argv'])

    def test_xdg_discovery_and_absent_display_settings(self):
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SWAYSOCK'):
            self.env.pop(name, None)
        self.assertEqual(self.run_launcher().returncode, 0)
        env = json.loads(self.capture.read_text())['env']
        for name in ('DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'SWAYSOCK'):
            self.assertNotIn(name, env)
        self.assertEqual(env['SDL_GAMECONTROLLERCONFIG'], 'firmware-map')
        self.assertEqual(env['PMJS_EXIT_HOTKEY'], 'none')
        self.assertNotIn('PMJS_GRAPHICS_DIAGNOSTICS', env)

    def test_standard_control_directory_priority(self):
        locations = [self.root / 'opt/system/Tools/PortMaster',
                     self.root / 'opt/tools/PortMaster', self.control,
                     self.root / 'roms/ports/PortMaster']
        for directory in locations:
            if directory != self.control:
                shutil.copytree(self.control, directory)
        for directory in locations:
            with self.subTest(directory=directory):
                self.assertEqual(self.run_launcher().returncode, 0)
                env = json.loads(self.capture.read_text())['env']
                self.assertEqual(env['SDL_GAMECONTROLLERCONFIG_FILE'], str(directory / 'gamecontrollerdb.txt'))
                shutil.rmtree(directory)

    def test_launcher_passes_bundle_and_writable_paths_to_pmjs(self):
        self.assertEqual(self.run_launcher().returncode, 0)
        arguments = json.loads(self.capture.read_text())['argv']
        self.assertIn(str(self.port), arguments)
        self.assertEqual(arguments[arguments.index('--save-root') + 1], str(self.port / 'saves'))
        self.assertEqual(arguments[arguments.index('--asset-cache-root') + 1], str(self.port / '.cache'))

    def test_graphics_diagnostics_honor_explicit_environment(self):
        for value in ('0', '1'):
            with self.subTest(value=value):
                self.assertEqual(self.run_launcher(PMJS_GRAPHICS_DIAGNOSTICS=value).returncode, 0)
                self.assertEqual(json.loads(self.capture.read_text())['env']['PMJS_GRAPHICS_DIAGNOSTICS'], value)

    def test_exit_helper_has_no_gameplay_bindings_and_honors_native_override(self):
        self.assertEqual(self.run_launcher().returncode, 0)
        helper = json.loads(self.gpt_capture.read_text())
        self.assertEqual(helper['argv'], ['node'])
        self.assertEqual(helper['wrapper'], 'active', 'multiword GPTOKEYB2 is a command line')
        self.assertEqual(self.run_launcher(PMJS_EXIT_HOTKEY='leftstick').returncode, 0)
        self.assertEqual(json.loads(self.capture.read_text())['env']['PMJS_EXIT_HOTKEY'], 'leftstick')

    def test_helper_return_status_does_not_abort_launch(self):
        result = self.run_launcher(CONTROLS_STATUS='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.capture.read_text())['env']['SDL_GAMECONTROLLERCONFIG'],
                         'firmware-map')

        result = self.run_launcher(PLATFORM_STATUS='1')
        self.assertEqual(result.returncode, 0)
        self.assertTrue(self.capture.exists())

    def test_exit_helper_stops_runtime_before_firmware_cleanup(self):
        for stopped in (False, True):
            with self.subTest(stopped=stopped):
                self.check_exit_helper(stopped)

    def check_exit_helper(self, stopped):
        read_fd, write_fd = os.pipe()
        target_fd, target_write_fd = os.pipe()
        process = None
        node_pid = None
        try:
            process = subprocess.Popen(['bash', self.launcher],
                                       env={**self.env, 'READY_FD': str(write_fd),
                                            'IGNORE_TERM': '1', 'KILL_TARGET_FD': str(target_fd)},
                                       pass_fds=(write_fd, target_fd), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            os.close(write_fd)
            write_fd = None
            self.assertTrue(select.select([read_fd], [], [], 5)[0], 'Node started')
            self.assertEqual(os.read(read_fd, 1), b'1')
            node_pid = json.loads(self.capture.read_text())['pid']
            if stopped:
                os.kill(node_pid, signal.SIGSTOP)
            os.write(target_write_fd, str(node_pid).encode())
            process.communicate(timeout=8)
            self.assertEqual(process.returncode, 0)
            with self.assertRaises(ProcessLookupError):
                os.kill(node_pid, 0)
            self.assertEqual(self.events.read_text().splitlines()[-1], 'finish:/firmware/lib')
        finally:
            os.close(read_fd)
            os.close(target_fd)
            os.close(target_write_fd)
            if write_fd is not None:
                os.close(write_fd)
            if node_pid:
                try:
                    os.kill(node_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process and process.poll() is None:
                process.kill()
                process.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main()
