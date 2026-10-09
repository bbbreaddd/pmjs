"""Incremental native builds and installation provenance using a compiled fixture."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class BuildProvenance(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs build provenance ')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for directory in ('src', 'cmake', 'tools', 'third_party', 'docs', 'js', 'runner', 'profiles', 'bin', 'test', 'dependencies'):
            (self.root / directory).mkdir()
        for source in ('tools/release.py', 'cmake/Install.cmake', 'cmake/build-config.json.in'):
            shutil.copy2(ROOT / source, self.root / source)
        for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/effekseer.LICENSE',
                     'third_party/effekseer-mz.patch', 'tools/effekseer.lock.json'):
            (self.root / name).write_text('fixture')
        (self.root / 'bin/pmjs').write_text('#!/bin/sh\nexit 0\n')
        for name in ('build-js-runtime.mjs', 'game-inspect.mjs', 'pmjs.mjs', 'package-self-test.cjs'):
            (self.root / 'tools' / name).write_text('// fixture\n')
        (self.root / '.gitignore').write_text('build/\ndist/\ndependencies/\n')
        (self.root / 'docs/using.md').write_text('Original documentation\n')
        (self.root / 'src/value.h').write_text('#define VALUE 10\n')
        (self.root / 'dependencies/provider.h').write_text('#define HEADER_VALUE 20\n')
        self.provider(1)
        (self.root / 'src/runtime.cpp').write_text('int runtime() { return 0; }\n')
        (self.root / 'src/addon.cpp').write_text(
            '#include "value.h"\n#include "provider.h"\nextern "C" int provider();\n'
            'extern "C" int value() { return VALUE + HEADER_VALUE + provider(); }\n')
        (self.root / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.20)
project(fixture VERSION 0.1.0 LANGUAGES C CXX)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_library(pmjs_runtime STATIC src/runtime.cpp)
add_library(Effekseer STATIC EXCLUDE_FROM_ALL src/runtime.cpp)
add_library(EffekseerRendererGL STATIC EXCLUDE_FROM_ALL src/runtime.cpp)
add_library(pmjs_native MODULE src/addon.cpp)
target_include_directories(pmjs_native PRIVATE dependencies)
target_link_libraries(pmjs_native PRIVATE pmjs_runtime "${CMAKE_SOURCE_DIR}/dependencies/libprovider.so")
set_target_properties(pmjs_native PROPERTIES PREFIX "" SUFFIX ".node")
set(PNG_LINK_LIBRARIES "${CMAKE_SOURCE_DIR}/dependencies/libprovider.so")
set(PMJS_RELEASE_PROVENANCE ON CACHE BOOL "")
include(cmake/Install.cmake)
''')
        self.command('git', 'init', '-q', str(self.root))
        self.command('git', '-C', str(self.root), 'add', '.')
        self.command('git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'Fixture')
        self.build = self.root / 'build'
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release')
        self.compile()

    def command(self, *args, success=True):
        result = subprocess.run(args, text=True, capture_output=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def provider(self, value):
        subprocess.run(['cc', '-shared', '-fPIC', '-x', 'c', '-', '-o', str(self.root / 'dependencies/libprovider.so')],
                       input=f'int provider(void) {{ return {value}; }}', text=True, check=True)

    def compile(self):
        return self.command('cmake', '--build', str(self.build), '--target', 'pmjs_native')

    def install(self, name, success=True):
        destination = self.root / 'dist' / name
        result = self.command('cmake', '--install', str(self.build), '--prefix', str(destination), success=success)
        return destination, result

    def test_distribution_edits_do_not_reconfigure_or_relink(self):
        addon = self.build / 'pmjs_native.node'
        before = (addon.read_bytes(), addon.stat().st_mtime_ns, (self.build / 'build-source.json').read_bytes())
        first, _ = self.install('first')
        for name in ('docs/using.md', 'js/module.js', 'test/check.cjs'):
            (self.root / name).write_text('Changed distribution content\n')
        result = self.compile()
        self.assertNotIn('Re-running CMake', result.stdout)
        self.assertNotIn('Linking', result.stdout)
        self.assertEqual(before, (addon.read_bytes(), addon.stat().st_mtime_ns,
                                  (self.build / 'build-source.json').read_bytes()))
        second, _ = self.install('second')
        old = json.loads((first / 'build-info.json').read_text())
        new = json.loads((second / 'build-info.json').read_text())
        self.assertNotEqual(old['source']['sourceSha256'], new['source']['sourceSha256'])
        self.assertNotEqual(old['files']['share/pmjs/docs/using.md'], new['files']['share/pmjs/docs/using.md'])
        self.assertEqual(old['compiledInputs'], new['compiledInputs'])

    def test_native_headers_libraries_flags_and_binary_are_checked(self):
        for index, (file, text) in enumerate([
            ('src/value.h', '#define VALUE 11\n'),
            ('dependencies/provider.h', '#define HEADER_VALUE 21\n')
        ]):
            (self.root / file).write_text(text)
            _, rejected = self.install(f'rejected-header-{index}', success=False)
            self.assertIn('Native inputs or binary changed', rejected.stdout + rejected.stderr)
            self.compile()
            self.install(f'header-{index}')
        self.provider(2)
        self.install('rejected-library', success=False)
        result = self.compile()
        self.assertIn('Linking', result.stdout)
        self.install('library')
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-DCMAKE_CXX_FLAGS=-DFIXTURE=1')
        self.install('rejected-flags', success=False)
        self.compile()
        self.install('flags')
        addon = self.build / 'pmjs_native.node'
        with addon.open('ab') as file:
            file.write(b'tampered')
        self.install('rejected-binary', success=False)


if __name__ == '__main__':
    unittest.main()
