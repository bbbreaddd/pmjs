#!/usr/bin/env python3
"""Stage, verify and archive the exact installed runtime, with build provenance."""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(file, value):
    payload = json.dumps(value, indent=2, sort_keys=True) + '\n'
    if file.exists() and file.read_text() == payload:
        return
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(payload)
    temporary.replace(file)


def git(source, *args):
    return subprocess.check_output(['git', '-C', source, *args])


def source_identity(source, required=True):
    if not required:
        return {'commit': 'unqualified', 'dirty': True, 'sourceSha256': None,
                'sourceDateEpoch': 0, 'files': {}}
    names = git(source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').split(b'\0')
    files = {os.fsdecode(name): digest(source / os.fsdecode(name)) for name in sorted(set(names))
             if name and (source / os.fsdecode(name)).is_file()}
    return {'commit': git(source, 'rev-parse', 'HEAD').decode().strip(),
            'dirty': bool(git(source, 'status', '--porcelain', '--untracked-files=normal').strip()),
            'sourceSha256': hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest(),
            'sourceDateEpoch': int(git(source, 'show', '-s', '--format=%ct', 'HEAD').decode()),
            'files': files}


def cache_values(build):
    values = {}
    for line in (build / 'CMakeCache.txt').read_text().splitlines():
        match = re.match(r'([^:#/][^:]*):[^=]+=(.*)', line)
        if match:
            values[match[1]] = match[2]
    return values


NATIVE_TARGET = r'CMakeFiles/(?:pmjs_native|pmjs_runtime|Effekseer|EffekseerRendererGL)\.dir/'


def compiled_identity(source, build):
    commands = [item for item in json.loads((build / 'compile_commands.json').read_text())
                if re.search(NATIVE_TARGET, item.get('command', item.get('output', '')))]
    if not commands:
        raise ValueError('No native compilation commands found')
    files = {Path(item['file']).resolve() for item in commands}
    files.update(file for file in (source / 'src').rglob('*')
                 if file.is_file() and file.suffix in ('.h', '.hpp', '.in'))
    files.update(file for file in (source / 'cmake').rglob('*') if file.is_file())
    files.update(source / name for name in ('CMakeLists.txt', 'tools/effekseer.lock.json',
                                           'third_party/effekseer-mz.patch', 'third_party/effekseer.LICENSE'))
    files.update(Path(line) for line in (build / 'build-inputs.txt').read_text().splitlines() if line)
    values = cache_values(build)
    settings = {key: value for key, value in values.items()
                if key.startswith(('CMAKE_C_', 'CMAKE_CXX_', 'CMAKE_MODULE_LINKER_FLAGS',
                                   'CMAKE_SHARED_LINKER_FLAGS', 'CMAKE_EXE_LINKER_FLAGS')) or
                key in ('CMAKE_BUILD_TYPE', 'CMAKE_SYSROOT', 'CMAKE_AR', 'CMAKE_LINKER', 'CMAKE_TOOLCHAIN_FILE') or
                'RPATH' in key}
    files.update(Path(values[key]) for key in ('CMAKE_C_COMPILER', 'CMAKE_CXX_COMPILER', 'CMAKE_AR', 'CMAKE_LINKER')
                 if values.get(key) and Path(values[key]).is_file())
    return {'files': {str(file): digest(file) for file in sorted(files)},
            'commands': sorted(commands, key=lambda item: item['file']), 'configuration': settings}


def compiled_dependencies(build):
    values = cache_values(build)
    if values.get('CMAKE_GENERATOR') != 'Ninja':
        raise ValueError('Release provenance requires the Ninja generator used by the CMake presets')
    dependencies = subprocess.check_output([values['CMAKE_MAKE_PROGRAM'], '-C', build, '-t', 'deps'], text=True)
    files, native = set(), False
    for line in dependencies.splitlines():
        if line.startswith('    '):
            if native:
                file = Path(line[4:])
                files.add(file.resolve() if file.is_absolute() else (build / file).resolve())
        else:
            native = bool(re.search(NATIVE_TARGET, line))
    if not files:
        raise ValueError('No completed native compiler dependencies found')
    return {str(file): digest(file) for file in sorted(files)}


def inventory(stage):
    result = {}
    for file in sorted(stage.rglob('*')):
        if file.is_symlink():
            raise ValueError('Release payload must contain regular files, not symlinks: ' + str(file))
        if file.is_file() and file != stage / 'build-info.json':
            result[str(file.relative_to(stage))] = {'sha256': digest(file), 'bytes': file.stat().st_size,
                                                    'mode': file.stat().st_mode & 0o777}
    return result


def elf(file):
    def read(option):
        return subprocess.check_output(['readelf', option, '--wide', file], text=True,
                                       env={**os.environ, 'LC_ALL': 'C'})
    header, dynamic = read('-h'), read('-d')
    if 'ELF64' not in header or 'little endian' not in header:
        raise ValueError('Expected a little-endian ELF64 binary: ' + str(file))
    paths = re.findall(r'\((?:RPATH|RUNPATH)\).*\[(.*?)\]', dynamic)
    for value in paths:
        if any(part not in ('$ORIGIN', '$ORIGIN/lib', '$ORIGIN/../lib') for part in value.split(':')):
            raise ValueError('Nonrelocatable search path: ' + value)
    return {'machine': re.search(r'Machine:\s+(.+)', header)[1].strip(),
            'needed': re.findall(r'\(NEEDED\).*\[(.*?)\]', dynamic), 'searchPaths': paths}


def static_audit(stage, info):
    addon = elf(stage / 'lib/pmjs_native.node')
    if info['architecture'] in ('aarch64', 'arm64'):
        module_spec = importlib.util.spec_from_file_location('abi', ROOT / 'tools/linux-arm64/audit-abi.py')
        abi = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(abi)
        report = abi.audit(stage / 'bin/node', stage / 'lib/pmjs_native.node', stage / 'lib')
        for artifact in report['artifacts']:
            artifact['path'] = str(Path(artifact['path']).relative_to(stage))
        return report
    if info['architecture'] not in ('x86_64', 'amd64', 'AMD64') or addon['machine'] != 'Advanced Micro Devices X86-64':
        raise ValueError('Unexpected addon architecture')
    result = {'architecture': 'x86_64', 'addon': addon, 'externalDependencies': addon['needed']}
    for library in (stage / 'lib').glob('*.so*'):
        if elf(library)['machine'] != addon['machine']:
            raise ValueError('Wrong shared-library architecture: ' + str(library))
    if (stage / 'bin/node').exists() and elf(stage / 'bin/node')['machine'] != addon['machine']:
        raise ValueError('Wrong Node architecture')
    return result


def sources(sdk, output):
    spec = json.loads((ROOT / 'tools/linux-arm64/sdk-recipes.json').read_text())
    cache = Path(os.environ.get('PMJS_DOWNLOAD_CACHE', ROOT / '.cache/linux-arm64/downloads'))
    output.mkdir(parents=True, exist_ok=True)
    for name, source in spec['sources'].items():
        if name == 'zig':
            continue
        archive = cache / source['url'].rsplit('/', 1)[-1]
        if not archive.is_file() or digest(archive) != source['sha256']:
            raise ValueError('Missing verified dependency source archive: ' + str(archive))
        shutil.copyfile(archive, output / (name + '-' + archive.name))
    for name in ['sdk-recipes.json', 'sdk-packages.json', 'prepare-sdk.py']:
        relative = Path('tools/linux-arm64') / name
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, destination)
    relative = Path('cmake/toolchains/portable-arm64.cmake')
    destination = output / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / relative, destination)
    shutil.copytree(sdk / 'records', output / 'build-records', dirs_exist_ok=True)


def manifest(stage, build, source):
    config = json.loads((build / 'build-config.json').read_text())
    values = cache_values(build)
    qualified = values.get('PMJS_RELEASE_PROVENANCE') == 'ON'
    identity = source_identity(source, qualified)
    if qualified:
        configured = json.loads((build / 'build-source.json').read_text())
        compiled = json.loads((build / 'build-compiled.json').read_text())
        inputs = compiled_identity(source, build)
        if (inputs != configured or compiled['inputs'] != inputs or
                compiled['dependencies'] != compiled_dependencies(build) or
                compiled['addonSha256'] != digest(build / 'pmjs_native.node')):
            raise ValueError('Native inputs or binary changed since compilation; build again before installation')
    info = {**config, 'schema': 1, 'source': identity,
            'compiledProvenance': qualified,
            'configuration': {key: value for key, value in values.items()
                              if key in ('CMAKE_C_FLAGS', 'CMAKE_CXX_FLAGS', 'PMJS_ENABLE_SANITIZERS',
                                         'PMJS_ENABLE_WERROR', 'PMJS_OFFLINE', 'BUILD_TESTING')},
            'node': {'bundled': (stage / 'bin/node').exists(), 'minimumNodeApi': 8},
            'files': inventory(stage)}
    if qualified:
        info['compiledInputs'] = compiled
    if config['targetEnvironment'] == 'ON':
        info['environment'] = {'recipes': json.loads((ROOT / 'tools/linux-arm64/sdk-recipes.json').read_text()),
                               'packages': json.loads((ROOT / 'tools/linux-arm64/sdk-packages.json').read_text())}
        info['node']['source'] = json.loads((ROOT / 'tools/linux-arm64/node.json').read_text())
    if (stage / 'share/pmjs/skia65-manifest.json').exists():
        info['skia65ComponentSha256'] = digest(stage / 'share/pmjs/skia65-manifest.json')
    info['loader'] = static_audit(stage, info)
    write_json(stage / 'build-info.json', info)


def checked_manifest(stage):
    info = json.loads((stage / 'build-info.json').read_text())
    if info.get('schema') != 1 or info['files'] != inventory(stage):
        raise ValueError('Installed package files differ from build-info.json')
    static_audit(stage, info)
    return info


def checked_smoke(info, package_hash, smoke):
    architecture = 'arm64' if info['architecture'] in ('aarch64', 'arm64') else 'x64'
    if (smoke.get('schema') != 1 or smoke.get('status') != 'passed' or not smoke.get('load') or
            smoke.get('packageSha256') != package_hash or smoke.get('architecture') != architecture or
            smoke.get('platform') != 'linux' or smoke.get('nodeApi', 0) < 8 or
            smoke.get('verifiedFiles') != len(info['files'])):
        raise ValueError('Smoke receipt does not verify this exact package')
    if info['node'].get('source') and smoke.get('node') != 'v' + info['node']['source']['version']:
        raise ValueError('Smoke receipt used a different Node release')


def verify(stage, report, graphics=False, xvfb=False, receipt=None, static=False):
    info = checked_manifest(stage)
    package_hash = digest(stage / 'build-info.json')
    if receipt:
        smoke = json.loads(receipt.read_text())
    elif static:
        smoke = None
    else:
        # Every execution uses a fresh copy and an environment without build-library paths.
        with tempfile.TemporaryDirectory(prefix='pmjs-relocated-') as directory:
            relocated = Path(directory) / 'runtime'
            shutil.copytree(stage, relocated)
            environment = {key: value for key, value in os.environ.items()
                           if key not in ('LD_LIBRARY_PATH', 'NODE_PATH', 'NODE_OPTIONS', 'PMJS_NATIVE_ADDON')}
            environment['SDL_AUDIODRIVER'] = 'dummy'
            environment['PMJS_WINDOW_SIZE'] = '32x24'
            environment.pop('PMJS_TEXT_BACKEND', None)
            command = [str(relocated / 'bin/pmjs'), 'self-test'] + (['--graphics'] if graphics else [])
            if xvfb:
                command = ['xvfb-run', '-a', *command]
                environment['LIBGL_ALWAYS_SOFTWARE'] = '1'
            process = subprocess.run(command, cwd=directory, env=environment, text=True,
                                     capture_output=True, timeout=120)
            if process.returncode:
                raise ValueError('Relocated smoke test failed:\n' + process.stdout + process.stderr)
            smoke = json.loads(process.stdout.strip().splitlines()[-1])
    if smoke:
        checked_smoke(info, package_hash, smoke)
    if inventory(stage) != info['files'] or digest(stage / 'build-info.json') != package_hash:
        raise ValueError('Package changed during verification')
    write_json(report, {'schema': 1, 'packageSha256': package_hash, 'static': 'passed', 'smoke': smoke,
                        'source': info['source']['commit']})
    print('Package verified:', report)


def archive(stage, report, output, development=False):
    info = checked_manifest(stage)
    verification = json.loads(report.read_text())
    if verification.get('schema') != 1 or verification.get('packageSha256') != digest(stage / 'build-info.json'):
        raise ValueError('Verification report belongs to a different package')
    smoke = verification.get('smoke')
    if verification.get('static') != 'passed':
        raise ValueError('Static package verification is required before archiving')
    if not development and (not smoke or not smoke.get('load')):
        raise ValueError('An executed smoke test is required before archiving')
    if smoke:
        checked_smoke(info, verification['packageSha256'], smoke)
    if not development and not (smoke.get('graphics') or {}).get('renderer'):
        raise ValueError('Public releases require a graphics smoke receipt for runtime initialization, rendering and shutdown')
    if not development and info['architecture'] in ('aarch64', 'arm64'):
        gpu = smoke.get('graphics')
        if not gpu or re.search(r'llvmpipe|softpipe|swiftshader', gpu.get('renderer', ''), re.I):
            raise ValueError('ARM64 releases require a graphics smoke receipt from a hardware renderer')
        if smoke.get('textBackend') != 'skia65':
            raise ValueError('ARM64 releases require the intended Skia65 text backend')
    if info['source']['dirty'] and not development:
        raise ValueError('Public releases require a clean source tree; --development creates a development candidate')
    if not info.get('compiledProvenance') and not development:
        raise ValueError('Public releases require compiled source provenance')
    output.parent.mkdir(parents=True, exist_ok=True)
    epoch = info['source']['sourceDateEpoch']
    temporary = output.with_suffix(output.suffix + '.tmp')
    with temporary.open('wb') as stream, gzip.GzipFile(filename='', mode='wb', fileobj=stream, mtime=epoch) as compressed:
        with tarfile.open(fileobj=compressed, mode='w', format=tarfile.GNU_FORMAT) as bundle:
            name = 'pmjs-linux-' + ('arm64' if info['architecture'] in ('arm64', 'aarch64') else 'x64')
            for file in [stage, *sorted(stage.rglob('*'))]:
                entry = bundle.gettarinfo(str(file), arcname=str(Path(name) / file.relative_to(stage)))
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ''
                entry.mtime = epoch
                if entry.isfile():
                    with file.open('rb') as payload:
                        bundle.addfile(entry, payload)
                else:
                    bundle.addfile(entry)
            payload = (json.dumps({**verification, 'distribution': 'development' if development else 'release'},
                                  indent=2, sort_keys=True) + '\n').encode()
            import io
            entry = tarfile.TarInfo(name + '.verification.json')
            entry.size, entry.mtime, entry.mode = len(payload), epoch, 0o644
            bundle.addfile(entry, io.BytesIO(payload))
    if inventory(stage) != info['files'] or verification['packageSha256'] != digest(stage / 'build-info.json'):
        temporary.unlink()
        raise ValueError('Package changed while archiving')
    temporary.replace(output)
    output.with_name(output.name + '.sha256').write_text(digest(output) + '  ' + output.name + '\n')
    print('Development archive:' if development else 'Verified release archive:', output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    command = commands.add_parser('provenance')
    command.add_argument('--source', type=Path, required=True)
    command.add_argument('--build', type=Path, required=True)
    command = commands.add_parser('sources')
    command.add_argument('--sdk', type=Path, required=True)
    command.add_argument('--output', type=Path, required=True)
    command = commands.add_parser('built')
    command.add_argument('--source', type=Path, required=True)
    command.add_argument('--build', type=Path, required=True)
    command.add_argument('--addon', type=Path, required=True)
    command = commands.add_parser('manifest')
    for name in ['stage', 'build', 'source']:
        command.add_argument('--' + name, type=Path, required=True)
    command = commands.add_parser('stage')
    command.add_argument('--build', type=Path, required=True)
    command.add_argument('--output', type=Path, required=True)
    command = commands.add_parser('verify')
    command.add_argument('--stage', type=Path, required=True)
    command.add_argument('--report', type=Path, required=True)
    command.add_argument('--graphics', action='store_true')
    command.add_argument('--xvfb', action='store_true')
    modes = command.add_mutually_exclusive_group()
    modes.add_argument('--receipt', type=Path)
    modes.add_argument('--static', action='store_true')
    command = commands.add_parser('archive')
    for name in ['stage', 'report', 'output']:
        command.add_argument('--' + name, type=Path, required=True)
    command.add_argument('--development', action='store_true', help='Create a candidate without public release qualification')
    args = parser.parse_args()
    try:
        if args.command == 'provenance':
            write_json(args.build / 'build-source.json', compiled_identity(args.source.resolve(), args.build.resolve()))
        elif args.command == 'built':
            configured = json.loads((args.build / 'build-source.json').read_text())
            if configured != compiled_identity(args.source.resolve(), args.build.resolve()):
                raise ValueError('Native inputs changed while compiling; build again')
            write_json(args.build / 'build-compiled.json',
                       {'inputs': configured, 'dependencies': compiled_dependencies(args.build.resolve()),
                        'addonSha256': digest(args.addon.resolve())})
        elif args.command == 'sources':
            sources(args.sdk.resolve(), args.output.resolve())
        elif args.command == 'manifest':
            manifest(args.stage.resolve(), args.build.resolve(), args.source.resolve())
        elif args.command == 'stage':
            if args.output.exists() and any(args.output.iterdir()):
                raise ValueError('Use an empty staging directory to avoid carrying old release files')
            subprocess.run(['cmake', '--build', args.build.resolve(), '--target', 'pmjs_native', '--parallel', '4'], check=True)
            subprocess.run(['cmake', '--install', args.build.resolve(), '--prefix', args.output.resolve()], check=True)
        elif args.command == 'verify':
            verify(args.stage.resolve(), args.report.resolve(), args.graphics, args.xvfb, args.receipt, args.static)
        elif args.command == 'archive':
            archive(args.stage.resolve(), args.report.resolve(), args.output.resolve(), args.development)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
