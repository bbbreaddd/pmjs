"""Installed-runtime metadata, file integrity and ELF compatibility checks."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
GRAPHICS_LIBRARY = re.compile(r'^(lib(SDL2|EGL|GLES|GL|gbm|Mali|mali|drm|wayland)|.*_dri\.so)')


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


def inventory(stage):
    result = {}
    for file in sorted(stage.rglob('*')):
        if file.is_symlink():
            raise ValueError('Runtime payload must contain regular files, not symlinks: ' + str(file))
        if file.is_file() and file != stage / 'build-info.json':
            result[str(file.relative_to(stage))] = {'sha256': digest(file), 'bytes': file.stat().st_size,
                                                    'mode': file.stat().st_mode & 0o777}
    return result


def payload_digest(files):
    checksum = hashlib.sha256()
    for name, entry in sorted(files.items()):
        checksum.update((name + '\0' + entry['sha256'] + '\0' + str(entry['bytes']) + '\n').encode())
    return checksum.hexdigest()


def read_elf(file, option):
    return subprocess.check_output(['readelf', option, '--wide', file], text=True,
                                   env={**os.environ, 'LC_ALL': 'C'})


def has_debug_sections(sections):
    return bool(re.search(r'\.(?:debug\w*|zdebug\w*|symtab)\b', sections))


def elf(file, *, stripping=False):
    header, dynamic = read_elf(file, '-h'), read_elf(file, '-d')
    if 'ELF64' not in header or 'little endian' not in header:
        raise ValueError('Expected a little-endian ELF64 binary: ' + str(file))
    paths = re.findall(r'\((?:RPATH|RUNPATH)\).*\[(.*?)\]', dynamic)
    for value in paths:
        if any(part not in ('$ORIGIN', '$ORIGIN/lib', '$ORIGIN/../lib') for part in value.split(':')):
            raise ValueError('Nonrelocatable search path: ' + value)
    result = {'machine': re.search(r'Machine:\s+(.+)', header)[1].strip(),
              'needed': re.findall(r'\(NEEDED\).*\[(.*?)\]', dynamic), 'searchPaths': paths}
    if stripping:
        result.update(dynamic=dynamic, needsStrip=has_debug_sections(read_elf(file, '-S')))
    return result


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
        if GRAPHICS_LIBRARY.match(library.name):
            raise ValueError('firmware graphics/window library must not be bundled: ' + library.name)
        if elf(library)['machine'] != addon['machine']:
            raise ValueError('Wrong shared-library architecture: ' + str(library))
    if (stage / 'bin/node').exists() and elf(stage / 'bin/node')['machine'] != addon['machine']:
        raise ValueError('Wrong Node architecture')
    return result


def strip_binary(file, tool, dynamic=None):
    symbols = read_elf(file, '--dyn-syms')
    if dynamic is None:
        dynamic = read_elf(file, '-d')
    subprocess.run([tool, '--strip-unneeded', file], check=True)
    if symbols != read_elf(file, '--dyn-syms') or dynamic != read_elf(file, '-d'):
        raise ValueError('Stripping changed dynamic symbols or loader information: ' + file.name)
    if has_debug_sections(read_elf(file, '-S')):
        raise ValueError('Strip tool left debug information: ' + file.name)


def strip_binaries(stage, tool):
    for directory in ('bin', 'lib'):
        for file in sorted((stage / directory).iterdir()):
            if not file.is_file():
                continue
            with file.open('rb') as stream:
                if stream.read(4) != b'\x7fELF':
                    continue
            strip_binary(file, tool)


def recognize_runtime(stage):
    """Recognize a replaceable installation; this does not verify its payload."""
    info = json.loads((stage / 'build-info.json').read_text())
    if info.get('schema') not in (1, 2):
        raise ValueError('Unsupported installed runtime metadata')
    for name in ('bin/pmjs', 'lib/pmjs_native.node', 'share/pmjs/tools/pmjs.mjs'):
        if not (stage / name).is_file():
            raise ValueError('Incomplete installed runtime: ' + name)
    return info


def checked_runtime(stage, *, files=None):
    """Verify supplied inventory or compact payload identity; plain installs have neither."""
    info = recognize_runtime(stage)
    if files is not None or 'files' in info or 'payloadSha256' in info:
        actual = inventory(stage)
        if (files is not None and files != actual) or ('files' in info and info['files'] != actual):
            raise ValueError('Installed package files differ from build-info.json or release record')
        if 'payloadSha256' in info and info['payloadSha256'] != payload_digest(actual):
            raise ValueError('Installed runtime payload checksum differs from build-info.json')
    else:
        for file in stage.rglob('*'):
            if file.is_symlink():
                raise ValueError('Runtime cannot contain symbolic links: ' + str(file))
    return info


def source_reference(archive, url=None):
    """Check corresponding-source materials without extracting an untrusted archive."""
    if url is not None and (not isinstance(url, str) or not re.fullmatch(r'https?://[^\s]+', url)):
        raise ValueError('Provide a permanent HTTP(S) source archive URL')
    prefix = 'pmjs-ffmpeg-sources/'
    required = {'build-records/ffmpeg.json', 'build-records/toolchain.json', 'build-records/sysroot.json',
                'tools/linux-arm64/prepare-sdk.py', 'tools/linux-arm64/sdk-recipes.json',
                'tools/linux-arm64/sdk-packages.json', 'cmake/toolchains/portable-arm64.cmake'}
    try:
        with tarfile.open(archive) as bundle:
            files = {}
            for entry in bundle:
                parts = entry.name.split('/')
                if entry.name != prefix.rstrip('/') and (not entry.name.startswith(prefix) or
                        any(part in ('', '.', '..') for part in parts) or '\\' in entry.name):
                    raise ValueError('Invalid source archive path')
                if not entry.isfile() and not entry.isdir():
                    raise ValueError('Source archive must contain regular files and directories')
                if entry.isfile():
                    if entry.name in files:
                        raise ValueError('Duplicate source archive file')
                    files[entry.name] = entry
            if not all(prefix + name in files for name in required):
                raise ValueError('Matching FFmpeg source and build materials are required')
            recipe = json.load(bundle.extractfile(files[prefix + 'build-records/ffmpeg.json']))['recipe']['source']
            spec = json.load(bundle.extractfile(files[prefix + 'tools/linux-arm64/sdk-recipes.json']))
            if recipe != spec['sources']['ffmpeg']:
                raise ValueError('FFmpeg source recipe differs from build materials')
            name = prefix + 'ffmpeg-' + recipe['url'].rsplit('/', 1)[-1]
            if name not in files:
                raise ValueError('Matching FFmpeg source archive is required')
            with bundle.extractfile(files[name]) as stream:
                if hashlib.file_digest(stream, 'sha256').hexdigest() != recipe['sha256']:
                    raise ValueError('FFmpeg source checksum differs from build materials')
            packages = json.load(bundle.extractfile(files[prefix + 'tools/linux-arm64/sdk-packages.json']))
            for source in packages.get('sources', []):
                name = prefix + 'libatomic/' + Path(source['Filename']).name
                if name not in files:
                    raise ValueError('Matching libatomic source is required: ' + name)
                with bundle.extractfile(files[name]) as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != source['SHA256']:
                        raise ValueError('libatomic source checksum differs from build materials')
    except (tarfile.TarError, EOFError, KeyError, TypeError) as error:
        raise ValueError('Invalid FFmpeg source archive: ' + str(error)) from error
    return {'filename': archive.name, 'sha256': digest(archive), **({'url': url} if url is not None else {})}
