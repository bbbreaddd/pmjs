"""Native installation and archive integrity using a compiled fixture."""
import ctypes
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import release
import build as build_command


class BuildCommand(unittest.TestCase):
    def setUp(self):
        temporary_root = ROOT / '.cache/tests'
        temporary_root.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='pmjs build command ', dir=temporary_root)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def test_output_symlinks_are_rejected_before_building(self):
        for existing in (True, False):
            with self.subTest(existing=existing):
                target = self.root / ('existing' if existing else 'missing')
                if existing:
                    target.mkdir()
                    (target / 'keep').write_text('preserved')
                output = self.root / ('existing-link' if existing else 'missing-link')
                output.symlink_to(target, target_is_directory=True)
                with mock.patch.object(sys, 'argv', ['build.py', '--output', str(output)]), \
                        mock.patch.object(build_command, 'require'), \
                        mock.patch.object(build_command.subprocess, 'run') as run:
                    with self.assertRaisesRegex(ValueError, 'Output cannot be a symbolic link'):
                        build_command.main()
                    run.assert_not_called()
                self.assertTrue(output.is_symlink())
                if existing:
                    self.assertEqual((target / 'keep').read_text(), 'preserved')
                else:
                    self.assertFalse(target.exists())

    def test_example_uses_the_public_launcher_and_preserves_arguments(self):
        example = self.root / 'example'
        example.mkdir()
        shutil.copy2(ROOT / 'example/run-game.sh', example / 'run-game.sh')
        launcher = self.root / 'dist/pmjs/bin/pmjs'
        launcher.parent.mkdir(parents=True)
        launcher.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
        launcher.chmod(0o755)
        game, saves = self.root / 'game files', self.root / 'save files'
        result = subprocess.run(['bash', str(example / 'run-game.sh'), str(game), str(saves)],
                                text=True, capture_output=True, check=True, cwd=self.root)
        self.assertEqual(result.stdout.splitlines(),
                         [str(game), '--save-root', str(saves), '--config', str(example / 'config.json')])


class BuildProvenance(unittest.TestCase):
    def setUp(self):
        temporary_root = ROOT / '.cache/tests'
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs build provenance ', dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for directory in ('src', 'cmake', 'tools', 'third_party', 'docs', 'js', 'runner', 'profiles', 'bin', 'test', 'dependencies'):
            (self.root / directory).mkdir()
        for source in ('tools/release.py', 'tools/runtime_artifact.py', 'tools/dependencies.py',
                       'cmake/Install.cmake', 'cmake/InstallMetadata.cmake.in',
                       'cmake/build-config.json.in'):
            shutil.copy2(ROOT / source, self.root / source)
        for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/effekseer.LICENSE',
                     'third_party/effekseer-mz.patch', 'tools/effekseer.lock.json',
                     'third_party/lz4.LICENSE', 'tools/lz4.lock.json'):
            (self.root / name).write_text('fixture')
        (self.root / 'bin/pmjs').write_text('#!/bin/sh\nexit 0\n')
        for name in ('build-js-runtime.mjs', 'build-js-composition.mjs', 'game-inspect.mjs', 'achievement-discovery.mjs', 'game-bundle.mjs', 'pmjs.mjs',
                     'package-self-test.cjs', 'portmaster.py', 'portmaster_metadata.py', 'verify-asset-index.cjs',
                     'linux-arm64/audit-abi.py'):
            (self.root / 'tools' / name).parent.mkdir(parents=True, exist_ok=True)
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
        (self.root / 'cmake/NativeOptions.cmake').write_text(
            'target_compile_definitions(pmjs_native PRIVATE FIXTURE_OPTION=1)\n')
        (self.root / 'CMakeLists.txt').write_text('''cmake_minimum_required(VERSION 3.20)
project(fixture VERSION 0.1.0 LANGUAGES C CXX)
find_package(Python3 REQUIRED COMPONENTS Interpreter)
add_library(pmjs_runtime STATIC src/runtime.cpp)
add_library(Effekseer STATIC EXCLUDE_FROM_ALL src/runtime.cpp)
add_library(EffekseerRendererGL STATIC EXCLUDE_FROM_ALL src/runtime.cpp)
add_library(pmjs_native MODULE src/addon.cpp)
include(cmake/NativeOptions.cmake)
target_include_directories(pmjs_native PRIVATE dependencies)
target_link_libraries(pmjs_native PRIVATE pmjs_runtime "${CMAKE_SOURCE_DIR}/dependencies/libprovider.so")
set_target_properties(pmjs_native PROPERTIES PREFIX "" SUFFIX ".node" INSTALL_RPATH "$ORIGIN")
install(FILES dependencies/libprovider.so DESTINATION lib COMPONENT runtime)
include(cmake/Install.cmake)
''')
        self.command('git', 'init', '-q', str(self.root))
        self.command('git', '-C', str(self.root), 'add', '.')
        self.command('git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-qm', 'Fixture')
        self.build = self.root / 'build'
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release')
        self.compile()

    def command(self, *args, success=True, env=None):
        result = subprocess.run(args, text=True, capture_output=True, env=env)
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

    def runtime_install(self, destination):
        for component in ('native-addon', 'runtime'):
            self.command('cmake', '--install', str(self.build), '--prefix', str(destination),
                         '--component', component)

    def install(self, name, success=True):
        destination = self.root / 'dist' / name
        self.runtime_install(destination)
        command = [sys.executable, str(self.root / 'tools/release.py'), 'manifest',
                   '--stage', str(destination), '--build', str(self.build), '--source', str(self.root)]
        values = release.cache_values(self.build)
        if values['CMAKE_BUILD_TYPE'] in ('Release', 'MinSizeRel'):
            command.extend(['--strip', values['CMAKE_STRIP']])
        result = self.command(*command, success=success)
        return destination, result

    def test_ordinary_build_and_install_do_not_require_release_accounting(self):
        shutil.rmtree(self.root / '.git')
        project = self.root / 'CMakeLists.txt'
        project.write_text(project.read_text().replace('find_package(Python3 REQUIRED COMPONENTS Interpreter)', ''))
        build = self.root / 'ordinary-build'
        self.command('cmake', '-S', str(self.root), '-B', str(build), '-G', 'Unix Makefiles')
        self.command('cmake', '--build', str(build), '--target', 'pmjs_native')
        stage = self.root / 'plain-installation'
        self.command('cmake', '--install', str(build), '--prefix', str(stage))
        info = json.loads((stage / 'build-info.json').read_text())
        self.assertNotIn('files', info)
        self.assertNotIn('compiledProvenance', info)
        self.assertEqual(info['source']['commit'], 'unknown')
        self.assertFalse((build / 'build-source.json').exists())
        self.assertFalse((build / 'build-compiled.json').exists())
        self.assertEqual(info['schema'], 2)
        self.assertEqual(release.checked_runtime(stage), info)
        with self.assertRaisesRegex(ValueError, 'Release inventory missing'):
            release.checked_manifest(stage)

    def test_distribution_edits_do_not_reconfigure_or_relink(self):
        addon = self.build / 'pmjs_native.node'
        before = (addon.read_bytes(), addon.stat().st_mtime_ns)
        first, _ = self.install('first')
        for name in ('docs/using.md', 'js/module.js', 'test/check.cjs'):
            (self.root / name).write_text('Changed distribution content\n')
        result = self.compile()
        self.assertNotIn('Re-running CMake', result.stdout)
        self.assertNotIn('Linking', result.stdout)
        self.assertEqual(before, (addon.read_bytes(), addon.stat().st_mtime_ns))
        second, _ = self.install('second')
        old = release.checked_manifest(first)
        new = release.checked_manifest(second)
        self.assertNotEqual(old['source']['sourceSha256'], new['source']['sourceSha256'])
        self.assertNotIn('share/pmjs/docs/using.md', new['files'])
        self.assertIn('share/pmjs/js/module.js', new['files'])

    def test_installation_cmake_changes_do_not_relink_native_code(self):
        addon = self.build / 'pmjs_native.node'
        before = (addon.read_bytes(), addon.stat().st_mtime_ns)
        first, _ = self.install('original-installation')
        installation = self.root / 'cmake/Install.cmake'
        installation.write_text(installation.read_text() +
            '\ninstall(FILES docs/using.md DESTINATION share/pmjs/notices RENAME extra.LICENSE)\n')
        # Even native CMake files can change without changing effective commands.
        for name in ('cmake/NativeOptions.cmake', 'CMakeLists.txt'):
            file = self.root / name
            file.write_text(file.read_text() + '\n# Documentation-only edit\n')
        (self.root / 'src/unused.h').write_text('#define UNUSED 1\n')
        template = self.root / 'cmake/build-config.json.in'
        template.write_text(template.read_text().replace('{', '{"distributionMarker":"fixture",', 1))
        result = self.compile()
        self.assertIn('Re-running CMake', result.stdout)
        self.assertNotIn('Linking', result.stdout)
        self.assertEqual(before, (addon.read_bytes(), addon.stat().st_mtime_ns))
        second, _ = self.install('changed-installation')
        self.assertEqual((second / 'share/pmjs/notices/extra.LICENSE').read_text(), 'Original documentation\n')
        old = release.checked_manifest(first)
        new = release.checked_manifest(second)
        self.assertEqual(new['distributionMarker'], 'fixture')
        self.assertNotEqual(old['source']['sourceSha256'], new['source']['sourceSha256'])

    def test_build_id_is_saved_at_install_without_relinking(self):
        addon = self.build / 'pmjs_native.node'
        before = (addon.read_bytes(), addon.stat().st_mtime_ns)
        for name, build_id in [('named', 'build-2026-10-15-abc1234-123-1'), ('local', '')]:
            destination = self.root / 'dist' / name
            self.command('cmake', '--install', str(self.build), '--prefix', str(destination),
                         env={**os.environ, 'PMJS_BUILD_ID': build_id})
            info = json.loads((destination / 'build-info.json').read_text())
            self.assertEqual(info['buildId'], build_id or None)
        self.assertEqual(before, (addon.read_bytes(), addon.stat().st_mtime_ns))
        for build_id in ('has spaces', 'build\nforged-log-line'):
            result = self.command('cmake', '--install', str(self.build), '--prefix', str(self.root / 'dist/invalid'),
                                  env={**os.environ, 'PMJS_BUILD_ID': build_id}, success=False)
            self.assertIn('PMJS_BUILD_ID must use', result.stdout + result.stderr)

    def test_release_strips_installed_binaries_before_verification(self):
        node = self.root / 'dependencies/node'
        (node / 'bin').mkdir(parents=True)
        (node / 'LICENSE').write_text('fixture license')
        subprocess.run(['cc', '-g', '-x', 'c', '-', '-o', node / 'bin/node'],
                       input='int main(void) { return 0; }', text=True, check=True)
        self.command('cmake', '-S', str(self.root), '-B', str(self.build),
                     '-DCMAKE_CXX_FLAGS=-g', '-DPMJS_NODE_ROOT=' + str(node))
        self.compile()
        originals = [self.build / 'pmjs_native.node', node / 'bin/node',
                     self.root / 'dependencies/libprovider.so']
        before = [file.read_bytes() for file in originals]
        self.assertIn('.debug_info', self.command('readelf', '-S', '--wide', str(originals[0])).stdout)
        stage, _ = self.install('stripped')
        for source, relative in zip(originals, ('lib/pmjs_native.node', 'bin/node', 'lib/libprovider.so')):
            target = stage / relative
            sections = self.command('readelf', '-S', '--wide', str(target)).stdout
            self.assertNotIn('.debug', sections)
            self.assertNotIn('.symtab', sections)
            self.assertEqual(self.command('readelf', '--dyn-syms', '--wide', str(source)).stdout,
                             self.command('readelf', '--dyn-syms', '--wide', str(target)).stdout)
        self.assertEqual([file.read_bytes() for file in originals], before)
        self.assertEqual(ctypes.CDLL(str(stage / 'lib/pmjs_native.node')).value(), 31)
        self.command(str(stage / 'bin/node'))
        info = release.checked_manifest(stage)
        self.assertEqual(set(info['loader']['addon']), {'machine', 'needed', 'searchPaths'})
        report = self.root / 'verification.json'
        release.verify(stage, report, static=True)
        output = self.root / 'archives/pmjs-linux-x64-1234567.tar.gz'
        release.archive(stage, report, output)
        self.assertEqual({file.name for file in output.parent.iterdir()},
                         {output.name, output.name + '.release.json', output.name + '.verification.json'})
        with tarfile.open(output) as archive:
            self.assertEqual(archive.extractfile('pmjs-linux-x64/lib/pmjs_native.node').read(),
                             (stage / 'lib/pmjs_native.node').read_bytes())
        self.assertEqual(info['files'], release.inventory(stage))

    def test_debug_installation_keeps_symbols(self):
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-DCMAKE_BUILD_TYPE=Debug')
        self.compile()
        stage, _ = self.install('debug')
        self.assertIn('.debug_info', self.command('readelf', '-S', '--wide',
                                                 str(stage / 'lib/pmjs_native.node')).stdout)

    def test_stripped_installation_manifest_is_repeatable(self):
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-DCMAKE_CXX_FLAGS=-g')
        self.compile()
        stage, _ = self.install('repeat-manifest')
        record = release.release_record(stage)
        before = (release.inventory(stage), (stage / 'build-info.json').read_bytes(), record.read_bytes())
        command = [sys.executable, str(self.root / 'tools/release.py'), 'manifest',
                   '--stage', str(stage), '--build', str(self.build), '--source', str(self.root),
                   '--strip', release.cache_values(self.build)['CMAKE_STRIP']]
        self.command(*command)
        self.assertEqual(before, (release.inventory(stage), (stage / 'build-info.json').read_bytes(), record.read_bytes()))

    def test_installation_rejects_strip_tool_that_leaves_symbols(self):
        self.command('cmake', '-S', str(self.root), '-B', str(self.build), '-DCMAKE_STRIP=/bin/true')
        self.compile()
        _, result = self.install('not-stripped', success=False)
        self.assertIn('Strip tool left debug information', result.stdout + result.stderr)

    def test_detached_provenance_is_bound_to_runtime_and_archive(self):
        stage, _ = self.install('detached')
        info = json.loads((stage / 'build-info.json').read_text())
        record = release.release_record(stage)
        details = json.loads(record.read_text())
        self.assertNotIn('files', info)
        self.assertIn('payloadSha256', info)
        self.assertNotIn('compiledInputs', info)
        self.assertNotIn('files', info['source'])
        self.assertNotIn('loader', info)
        self.assertNotIn('compiledInputs', details)
        self.assertIn('files', details['source'])
        self.assertFalse((stage / 'share/pmjs/docs').exists())
        self.assertFalse((stage / 'share/pmjs/tools/portmaster.py').exists())
        (stage / 'LICENSE').chmod(0o664)
        details['files']['LICENSE']['mode'] = 0o664
        record.write_text(json.dumps(details))
        report = self.root / 'verification.json'
        release.verify(stage, report, static=True)
        output = self.root / 'candidate.tar.gz'
        release.archive(stage, report, output)
        verification = json.loads(output.with_name(output.name + '.verification.json').read_text())
        self.assertEqual(verification['archive']['sha256'], release.digest(output))
        self.assertEqual(verification['releaseRecordSha256'], release.digest(record))
        self.assertEqual(json.loads(output.with_name(output.name + '.release.json').read_text()), details)
        with tarfile.open(output) as archive:
            self.assertFalse(any('docs/' in item.name or item.name.endswith('.py') or
                                 item.name.endswith('.release.json') or item.name.endswith('.verification.json')
                                 for item in archive))
        release.verify_archive(output)
        self.assertNotIn('distribution', verification)
        archived_report = output.with_name(output.name + '.verification.json')
        for distribution in ('development', 'release'):
            release.write_json(archived_report, {**verification, 'distribution': distribution})
            release.verify_archive(output)
        before = output.read_bytes()
        output.write_bytes(b'changed archive')
        with self.assertRaisesRegex(ValueError, 'Archive differs'):
            release.verify_archive(output)
        output.write_bytes(before)
        details['source']['commit'] = 'different provenance'
        release.write_json(record, details)
        with self.assertRaisesRegex(ValueError, 'different release record'):
            release.archive(stage, report, output)
        self.assertEqual(output.read_bytes(), before)
        info['architecture'] = 'different runtime'
        release.write_json(stage / 'build-info.json', info)
        with self.assertRaisesRegex(ValueError, 'different runtime'):
            release.checked_manifest(stage)


class DependencySources(unittest.TestCase):
    def setUp(self):
        temporary_root = ROOT / '.cache/tests'
        temporary_root.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix='pmjs dependency sources ', dir=temporary_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('tools/release.py', 'tools/runtime_artifact.py', 'tools/dependencies.py',
                     'tools/linux-arm64/sdk-recipes.json',
                     'tools/linux-arm64/sdk-packages.json', 'tools/linux-arm64/prepare-sdk.py',
                     'cmake/toolchains/portable-arm64.cmake'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        # This suite supplies a prepared miniature SDK; SDK cache verification has its own suite.
        (self.root / 'tools/linux-arm64/prepare-sdk.py').write_text('import sys\nassert \"--verify\" in sys.argv\n')
        self.cache = self.root / 'downloads'
        self.cache.mkdir()
        spec_file = self.root / 'tools/linux-arm64/sdk-recipes.json'
        spec = json.loads(spec_file.read_text())
        self.archive = self.cache / spec['sources']['ffmpeg']['url'].rsplit('/', 1)[-1]
        self.archive.write_bytes(b'matching media source archive')
        spec['sources']['ffmpeg']['sha256'] = release.digest(self.archive)
        release.write_json(spec_file, spec)
        self.sdk = self.root / 'sdk'
        (self.sdk / 'records').mkdir(parents=True)
        for component in ('ffmpeg', 'toolchain', 'sysroot'):
            release.write_json(self.sdk / 'records' / (component + '.json'),
                               {'component': component, 'recipe': {'source': spec['sources']['ffmpeg']}})
        packages_file = self.root / 'tools/linux-arm64/sdk-packages.json'
        packages = json.loads(packages_file.read_text())
        self.atomic_sources = []
        for source in packages['sources']:
            file = self.cache / Path(source['Filename']).name
            file.write_bytes(('matching ' + file.name).encode())
            source['SHA256'] = release.digest(file)
            self.atomic_sources.append(file)
        release.write_json(packages_file, packages)
        self.output = self.root / 'installed sources'

    def sources(self):
        return subprocess.run([sys.executable, '-c',
                               'from dependencies import sources; from pathlib import Path; import sys; '
                               'sources(Path(sys.argv[1]), Path(sys.argv[2]))', self.sdk, self.output],
                              cwd=self.root / 'tools', text=True, capture_output=True,
                              env={**os.environ, 'PMJS_DOWNLOAD_CACHE': str(self.cache)})

    def test_dependency_sources_are_shipped_with_rebuild_materials(self):
        result = self.sources()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual({str(file.relative_to(self.output)) for file in self.output.rglob('*') if file.is_file()},
                         {'ffmpeg-' + self.archive.name,
                          'tools/linux-arm64/sdk-recipes.json', 'tools/linux-arm64/sdk-packages.json',
                          'tools/linux-arm64/prepare-sdk.py', 'cmake/toolchains/portable-arm64.cmake',
                          'build-records/ffmpeg.json', 'build-records/toolchain.json', 'build-records/sysroot.json'} |
                         {'libatomic/' + file.name for file in self.atomic_sources})
        self.assertEqual((self.output / ('ffmpeg-' + self.archive.name)).read_bytes(), self.archive.read_bytes())
        self.assertEqual((self.output / 'cmake/toolchains/portable-arm64.cmake').read_bytes(),
                         (ROOT / 'cmake/toolchains/portable-arm64.cmake').read_bytes())

    def test_unchanged_materials_are_not_recopied_and_changed_materials_are_refreshed(self):
        self.assertEqual(self.sources().returncode, 0)
        before = {file: file.stat().st_mtime_ns for file in self.output.rglob('*') if file.is_file()}
        self.assertEqual(self.sources().returncode, 0)
        self.assertEqual(before, {file: file.stat().st_mtime_ns for file in before})
        material = Path('tools/linux-arm64/prepare-sdk.py')
        (self.root / material).write_text('# changed build material\n')
        damaged = self.output / ('ffmpeg-' + self.archive.name)
        damaged.write_bytes(b'damaged copied archive')
        self.assertEqual(self.sources().returncode, 0)
        self.assertEqual((self.output / material).read_text(), '# changed build material\n')
        self.assertEqual(damaged.read_bytes(), self.archive.read_bytes())

    def test_direct_source_archive_is_separate_and_repeatable(self):
        output = self.root / 'sources.tar.gz'
        def archive():
            result = subprocess.run([sys.executable, self.root / 'tools/release.py', 'sources',
                                     '--sdk', self.sdk, '--output', output], text=True, capture_output=True,
                                    env={**os.environ, 'PMJS_DOWNLOAD_CACHE': str(self.cache)})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        archive()
        before = output.read_bytes()
        archive()
        self.assertEqual(output.read_bytes(), before)
        with tarfile.open(output) as bundle:
            self.assertFalse(any(item.name.endswith('build-info.json') for item in bundle))
            self.assertEqual(bundle.extractfile('pmjs-ffmpeg-sources/ffmpeg-' + self.archive.name).read(),
                             self.archive.read_bytes())
        reference = release.source_reference(output, 'https://example.invalid/sources.tar.gz')
        self.assertEqual(reference['sha256'], release.digest(output))
        # The record and source archive are companions of the runtime, never its files.
        stage = self.root / 'runtime'
        (stage / 'bin').mkdir(parents=True)
        (stage / 'lib').mkdir()
        (stage / 'share/pmjs/tools').mkdir(parents=True)
        for name in ('bin/pmjs', 'lib/pmjs_native.node', 'share/pmjs/tools/pmjs.mjs'):
            (stage / name).touch()
        release.write_json(stage / 'build-info.json', {'schema': 1, 'files': release.inventory(stage),
                                                     'node': {}, 'architecture': 'x86_64',
                                                     'source': {'commit': 'fixture', 'dirty': True, 'sourceDateEpoch': 0},
                                                     'dependencySources': reference})
        release.write_json(release.release_record(stage), {'schema': 1, 'files': release.inventory(stage),
                           'packageSha256': release.digest(stage / 'build-info.json')})
        from unittest.mock import patch
        with patch.object(release, 'static_audit'):
            release.checked_manifest(stage)
            report = self.root / 'verification.json'
            release.verify(stage, report, static=True)
            exported = self.root / 'exported/runtime.tar.gz'
            release.archive(stage, report, exported)
            self.assertEqual((exported.parent / output.name).read_bytes(), before)
            release.verify_archive(exported)
            output.write_bytes(b'corrupt source archive')
            with self.assertRaisesRegex(ValueError, 'Source archive differs'):
                release.checked_manifest(stage)

    def test_missing_or_changed_atomic_sources_are_rejected(self):
        source = self.atomic_sources[0]
        for content in (b'changed source archive', None):
            with self.subTest(content=content):
                if content is None:
                    source.unlink()
                else:
                    source.write_bytes(content)
                result = self.sources()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Missing verified dependency source archive', result.stderr)

    def test_source_archive_rejects_missing_or_changed_atomic_sources(self):
        self.assertEqual(self.sources().returncode, 0)
        source = self.output / 'libatomic' / self.atomic_sources[0].name
        output = self.root / 'sources.tar.gz'
        for content in (b'changed source archive', None):
            with self.subTest(content=content):
                if content is None:
                    source.unlink()
                else:
                    source.write_bytes(content)
                with tarfile.open(output, 'w:gz') as bundle:
                    bundle.add(self.output, arcname='pmjs-ffmpeg-sources')
                with self.assertRaisesRegex(ValueError, 'libatomic source'):
                    release.source_reference(output)

    def test_missing_or_changed_media_sources_are_rejected(self):
        for content in (b'changed source archive', None):
            with self.subTest(content=content):
                if content is None:
                    self.archive.unlink()
                else:
                    self.archive.write_bytes(content)
                result = self.sources()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Missing verified dependency source archive', result.stderr)
                self.assertFalse((self.output / ('ffmpeg-' + self.archive.name)).exists())


if __name__ == '__main__':
    unittest.main()
