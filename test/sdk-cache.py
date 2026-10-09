"""SDK recipe invalidation and clean rebuilds using compiled local fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class SdkCache(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs-sdk-cache-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.tools = self.root / 'tools/linux-arm64'
        self.tools.mkdir(parents=True)
        for name in ('prepare-sdk.py', 'sdk-recipes.json', 'sdk-packages.json'):
            shutil.copy2(ROOT / 'tools/linux-arm64' / name, self.tools / name)
        toolchains = self.root / 'cmake/toolchains'
        toolchains.mkdir(parents=True)
        (toolchains / 'portable-arm64.cmake').write_text('set(CMAKE_SYSTEM_NAME Linux)\n')
        spec = importlib.util.spec_from_file_location('sdk', self.tools / 'prepare-sdk.py')
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)
        self.spec = json.loads((self.tools / 'sdk-recipes.json').read_text())
        self.sdk = self.root / 'sdk'
        (self.sdk / 'bin').mkdir(parents=True)
        for name in ('cc', 'c++', 'ar', 'ranlib'):
            (self.sdk / 'bin' / name).symlink_to(shutil.which(name))
        self.cache = self.root / 'downloads'
        self.cache.mkdir()
        self.environment = patch.dict(os.environ, {'PMJS_DOWNLOAD_CACHE': str(self.cache)})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def archive(self, name, files):
        source = self.root / (name + '-original')
        source.mkdir()
        for file, text in files.items():
            (source / file).write_text(text)
        if (source / 'configure').exists():
            (source / 'configure').chmod(0o755)
        archive = self.cache / (name + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as bundle:
            bundle.add(source, arcname=name)
        self.spec['sources'][name] = {'url': 'https://invalid.example/' + archive.name,
                                      'sha256': self.builder.digest(archive)}
        self.spec['components'][name] = {'options': [], 'dependencies': []}
        return self.builder.recipes(self.sdk, self.spec)[name], archive

    def build(self, name, recipe):
        files = self.builder.build_component(self.sdk, name, self.spec, recipe, 2)
        self.builder.complete(self.sdk, name, recipe, files)

    def value(self, file):
        result = subprocess.check_output([sys.executable, '-c',
            'import ctypes,sys; print(ctypes.CDLL(sys.argv[1]).value())', str(file)], text=True)
        return int(result)

    def test_diagnostics_preserve_cache_and_recipe_revisions_invalidate_it(self):
        before = self.builder.recipes(self.sdk, self.spec)
        for name, recipe in before.items():
            self.builder.complete(self.sdk, name, recipe, [])
        script = self.tools / 'prepare-sdk.py'
        script.write_text(script.read_text() + '\n# Diagnostic-only edit\n')
        self.assertEqual(before, self.builder.recipes(self.sdk, self.spec))
        self.spec['revision'] += 1
        (self.tools / 'sdk-recipes.json').write_text(json.dumps(self.spec))
        after = self.builder.recipes(self.sdk, self.spec)
        self.assertEqual(before.keys(), after.keys())
        for name in before:
            self.assertNotEqual(before[name], after[name], name)
        with self.assertRaisesRegex(ValueError, 'changed revision'):
            self.builder.prepare_locked(self.sdk, 2, verify=True)

    def test_compiler_and_dependency_changes_discard_cmake_cache(self):
        recipe, archive = self.archive('zlib', {
            'LICENSE': 'fixture license', 'fixture.c': 'int value(void) { return 42; }',
            'CMakeLists.txt': '''cmake_minimum_required(VERSION 3.20)
project(fixture C)
if(STALE_CONFIGURATION)
  message(FATAL_ERROR "Stale CMake cache survived")
endif()
add_library(fixture SHARED fixture.c)
install(TARGETS fixture LIBRARY DESTINATION lib)
'''
        })
        checksum = self.builder.digest(archive)
        self.build('zlib', recipe)
        for field, value in (('toolchain', 'changed-compiler'), ('dependencies', {'freetype': 'changed-dependency'})):
            with self.subTest(field=field):
                build = self.sdk / 'work/zlib-build'
                with (build / 'CMakeCache.txt').open('a') as cache:
                    cache.write('\nSTALE_CONFIGURATION:BOOL=ON\n')
                (build / 'stale.o').write_text('old object')
                recipe = {**recipe, field: value}
                self.assertIsNotNone(self.builder.cache_reason(self.sdk, self.builder.read_record(self.sdk, 'zlib'), recipe))
                self.build('zlib', recipe)
                self.assertFalse((build / 'stale.o').exists())
                self.assertEqual(self.value(self.sdk / 'prefix/lib/libfixture.so'), 42)
                self.assertEqual(self.builder.digest(archive), checksum, 'download cache is preserved')
                self.assertIsNone(self.builder.cache_reason(self.sdk, self.builder.read_record(self.sdk, 'zlib'), recipe))
        with (self.sdk / 'prefix/lib/libfixture.so').open('ab') as output:
            output.write(b'corrupt')
        self.assertRegex(self.builder.cache_reason(self.sdk, self.builder.read_record(self.sdk, 'zlib'), recipe),
                         'changed output')

    def test_ffmpeg_rebuild_discards_in_source_objects(self):
        configure = '#!' + sys.executable + '\n' + '''import sys
from pathlib import Path
args = dict(arg[2:].split('=', 1) for arg in sys.argv[1:] if '=' in arg)
Path('Makefile').write_text("""all: libfixture.so
fixture.o: fixture.c
\t{cc} -fPIC -DVALUE={value} -c fixture.c -o fixture.o
libfixture.so: fixture.o
\t{cc} -shared fixture.o -o libfixture.so
install: all
\tmkdir -p $(DESTDIR){prefix}/lib
\tcp libfixture.so $(DESTDIR){prefix}/lib/
""".format(cc=args['cc'], value=args['value'], prefix=args['prefix']))
'''
        recipe, archive = self.archive('ffmpeg', {
            'LICENSE': 'fixture license', 'configure': configure,
            'fixture.c': 'int value(void) { return VALUE; }'
        })
        recipe['component']['options'] = ['--value=41']
        checksum = self.builder.digest(archive)
        self.build('ffmpeg', recipe)
        self.assertEqual(self.value(self.sdk / 'prefix/lib/libfixture.so'), 41)
        source = self.sdk / 'work/ffmpeg/ffmpeg'
        self.assertTrue((source / 'fixture.o').exists())
        (source / 'stale.o').write_text('old object')
        recipe = {**recipe, 'component': {**recipe['component'], 'options': ['--value=42']}}
        self.build('ffmpeg', recipe)
        self.assertFalse((source / 'stale.o').exists())
        self.assertEqual(self.value(self.sdk / 'prefix/lib/libfixture.so'), 42, 'new compiler options reached the object')
        self.assertEqual(self.builder.digest(archive), checksum)
        self.assertIsNone(self.builder.cache_reason(self.sdk, self.builder.read_record(self.sdk, 'ffmpeg'), recipe))


if __name__ == '__main__':
    unittest.main()
