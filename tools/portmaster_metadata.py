"""Import author-supplied PortMaster metadata for a self-contained PMJS port."""
import json
import re
import shutil
import struct
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree


PORTNAME = re.compile(r'[a-z0-9]+\Z')


def portname_from_title(title):
    """Convert a display title to the PortMaster portname character set."""
    if not isinstance(title, str):
        raise ValueError('Game name must produce a valid PortMaster portname; specify --name')
    portname = re.sub(r'[^a-z0-9]+', '', title.lower())
    if not PORTNAME.fullmatch(portname):
        raise ValueError('Game name must produce a valid PortMaster portname; specify --name')
    return portname


def _regular(file):
    if file.is_symlink() or not file.is_file():
        raise ValueError(f'Missing or non-regular submission file: {file}')
    return file


def _image(directory, stem, required):
    image = directory / (stem + '.png')
    if required and not image.exists():
        raise ValueError(f'Expected {"one" if required else "at most one"} {stem}.png')
    if (directory / (stem + '.jpg')).exists():
        raise ValueError(f'{stem}.jpg is not accepted; use a PNG file')
    if not image.exists():
        return None
    return _regular(image)


def _image_dimensions(file):
    with file.open('rb') as image:
        header = image.read(24)
        if (len(header) == 24 and header.startswith(b'\x89PNG\r\n\x1a\n') and
                header[12:16] == b'IHDR'):
            return struct.unpack('>II', header[16:24])
        if header[:2] != b'\xff\xd8':
            raise ValueError(f'Unsupported screenshot image: {file.name}')
        image.seek(2)
        while marker_prefix := image.read(1):
            if marker_prefix != b'\xff':
                continue
            marker = image.read(1)
            while marker == b'\xff':
                marker = image.read(1)
            if not marker or marker in (b'\x00', b'\xd8', b'\xd9') or b'\xd0' <= marker <= b'\xd7':
                continue
            if marker == b'\xda':
                break
            length = image.read(2)
            if len(length) != 2:
                break
            segment_length = struct.unpack('>H', length)[0]
            if segment_length < 2:
                break
            if marker[0] in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
                             0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                frame = image.read(5)
                if len(frame) == 5:
                    height, width = struct.unpack('>HH', frame[1:5])
                    return width, height
                break
            image.seek(segment_length - 2, 1)
    raise ValueError(f'Could not read screenshot dimensions: {file.name}')


def _required_text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'port.json {field} must be a nonempty string')
    return value


def _validate_metadata(metadata):
    items_opt = metadata.get('items_opt')
    if not isinstance(items_opt, list) or items_opt:
        raise ValueError('port.json items_opt must be an empty array for PMJS packages')
    attr = metadata.get('attr')
    if not isinstance(attr, dict):
        raise ValueError('port.json attr must be an object')

    for field in ('title', 'desc', 'inst'):
        value = _required_text(attr.get(field), f'attr.{field}')
        if field != 'title':
            markdown = re.search(r'(?:^|\s)[#>*+-]\s|`|(?:\*\*|__|~~)|\[[^]]+\]\([^)]+\)', value)
            if '\n' in value or '\r' in value or r'\n' in value or markdown:
                raise ValueError(f'port.json attr.{field} must be one-line plain text')
    porter = attr.get('porter')
    if not isinstance(porter, list) or not porter or any(
            not isinstance(name, str) or not name.strip() or
            re.sub(r'[^a-z]', '', name.lower()) in {'yourhandle', 'placeholder', 'todo', 'tbd'}
            for name in porter):
        raise ValueError('port.json attr.porter must contain porter names, not placeholders')
    if not isinstance(attr.get('genres'), list) or not attr['genres'] or any(
            not isinstance(genre, str) or genre not in {
                'action', 'adventure', 'arcade', 'casino-card', 'fps', 'platformer',
                'puzzle', 'racing', 'rhythm', 'rpg', 'simulation', 'sports',
                'strategy', 'visual-novel', 'other'}
            for genre in attr['genres']):
        raise ValueError('port.json attr.genres must use current PortMaster genre slugs')
    for field in ('desc_md', 'inst_md'):
        if field not in attr or (attr[field] is not None and not isinstance(attr[field], str)):
            raise ValueError(f'port.json attr.{field} must be a string or null')
    if 'image' not in attr or (attr['image'] is not None and not isinstance(attr['image'], str)):
        raise ValueError('port.json attr.image must be a string or null')
    if not isinstance(attr.get('exp'), bool):
        raise ValueError('port.json attr.exp must be a boolean')
    if not isinstance(attr.get('store'), list) or any(
            not isinstance(store, dict) or any(
                not isinstance(store.get(field), str) or not store[field].strip()
                for field in ('name', 'gameurl', 'developerurl'))
            for store in attr['store']):
        raise ValueError('port.json attr.store must be an array of complete store links')
    if not isinstance(attr.get('availability'), str) or not attr['availability'].strip():
        raise ValueError('port.json attr.availability must be a nonempty string')
    if not isinstance(attr.get('reqs'), list) or any(not isinstance(req, str) for req in attr['reqs']):
        raise ValueError('port.json attr.reqs must be an array of strings')
    if not isinstance(attr.get('min_glibc'), str):
        raise ValueError('port.json attr.min_glibc must be a string')
    if not isinstance(attr.get('arch'), list) or any(
            architecture not in {'aarch64', 'armhf', 'x86_64', 'x86'}
            for architecture in attr['arch']):
        raise ValueError('port.json attr.arch must use supported architecture names')
    if attr.get('runtime') and attr['arch']:
        raise ValueError('port.json attr.runtime and attr.arch are mutually exclusive')


def read_submission(directory):
    """Read the files normally authored for a PortMaster-New port PR."""
    if directory is None:
        return None
    directory = Path(directory).resolve()
    portname = directory.name
    if not PORTNAME.fullmatch(portname) or not directory.is_dir():
        raise ValueError('Submission must be a directory with a valid PortMaster portname')
    metadata = json.loads(_regular(directory / 'port.json').read_text(encoding='utf-8'))
    if not isinstance(metadata, dict) or metadata.get('version') != 4 or metadata.get('name') != portname + '.zip':
        raise ValueError('Expected PortMaster v4 port.json matching the submission directory')
    _validate_metadata(metadata)
    items = metadata.get('items')
    if not isinstance(items, list) or len(items) != 2 or items[1] != portname:
        raise ValueError('port.json items must specify the launcher and this port directory')
    launcher = items[0]
    if not isinstance(launcher, str) or not launcher.endswith('.sh') or not launcher[:-3] or re.search(r'[\x00-\x1f/\\]', launcher):
        raise ValueError('Invalid PortMaster launcher name in port.json')
    attr = metadata.get('attr')
    if not isinstance(attr, dict) or attr.get('rtr') is not False or attr.get('runtime') != []:
        raise ValueError('PMJS submission must require game data (rtr=false) and bundle its own runtime')
    if not isinstance(attr.get('arch'), list) or len(attr['arch']) != 1:
        raise ValueError('port.json must select exactly one PMJS architecture')

    readme = _regular(directory / 'README.md').read_text(encoding='utf-8')
    headings = re.findall(r'^##? .+$', readme, flags=re.MULTILINE)
    if (not readme.startswith('## Notes\n') or headings[:3] !=
            ['## Notes', '## Controls', '## Compile'] or readme.startswith('# ')):
        raise ValueError('README.md must start with Notes, Controls, and Compile sections')
    xml = _regular(directory / 'gameinfo.xml')
    try:
        root = ElementTree.parse(xml).getroot()
    except ElementTree.ParseError as error:
        raise ValueError('Invalid gameinfo.xml') from error
    game = root.find('game') if root.tag == 'gameList' else None
    if game is None or game.findtext('path') != './' + launcher:
        raise ValueError('gameinfo.xml path must match the launcher')
    game_fields = ('path', 'name', 'desc', 'releasedate', 'developer', 'publisher', 'genre', 'image')
    if (len(game) != len(game_fields) or {child.tag for child in game} != set(game_fields) or
            any(not (game.findtext(field) or '').strip() for field in game_fields)):
        raise ValueError('gameinfo.xml must contain only the current required game fields')
    releasedate = game.findtext('releasedate', '')
    if not re.fullmatch(r'\d{8}T000000', releasedate):
        raise ValueError('gameinfo.xml releasedate must use YYYYMMDDT000000 format')
    try:
        datetime.strptime(releasedate, '%Y%m%dT%H%M%S')
    except ValueError as error:
        raise ValueError('gameinfo.xml releasedate must be a real calendar date') from error
    screenshot = _image(directory, 'screenshot', required=True)
    width, height = _image_dimensions(screenshot)
    if width < 640 or height < 480 or width * 3 != height * 4:
        raise ValueError('PortMaster screenshot must be 4:3 and at least 640x480')
    cover = _image(directory, 'cover', required=False)
    expected_images = {'./' + portname + '/' + (cover or screenshot).name,
                       './' + portname + '/' + screenshot.name}
    if game.findtext('image') not in expected_images:
        raise ValueError('gameinfo.xml image must reference the screenshot or cover')
    return {'directory': directory, 'portname': portname, 'launcher': launcher,
            'metadata': metadata, 'screenshot': screenshot, 'cover': cover}


def stage_submission(destination, port, data, stage, info, notices, extra_notices):
    """Stage authored metadata at the selected package level."""
    architecture = {'arm64': 'aarch64', 'aarch64': 'aarch64',
                    'x64': 'x86_64', 'x86_64': 'x86_64'}.get(info['architecture'])
    if architecture is None or data['metadata']['attr']['arch'] != [architecture]:
        raise ValueError('port.json architecture does not match the packaged runtime')
    source = data['directory']
    shutil.copyfile(source / 'port.json', destination / 'port.json')
    shutil.copyfile(source / 'README.md', destination / 'README.md')
    for file in (data['screenshot'], data['cover']):
        if file:
            shutil.copyfile(file, destination / file.name)
    shutil.copyfile(source / 'gameinfo.xml', destination / 'gameinfo.xml')
    thread = source / 'testing_thread.txt'
    if thread.exists():
        shutil.copyfile(_regular(thread), destination / thread.name)
    patches = source / 'patches'
    if patches.exists():
        for file in (patches, *patches.rglob('*')):
            if file.is_symlink() or not (file.is_file() or file.is_dir()):
                raise ValueError('Patches must contain only regular files and directories')
            if file.is_file() and (destination / file.relative_to(source)).exists():
                raise ValueError('Submission patch conflicts with a bundled file: ' + file.name)
        shutil.copytree(patches, destination / 'patches', dirs_exist_ok=True)

    licenses = port / 'licenses'
    licenses.mkdir()
    used = set()
    for file in (*notices, *extra_notices):
        _regular(file)
        try:
            origin = file.relative_to(stage).as_posix()
        except ValueError:
            origin = 'additional/' + file.name
        label = re.sub(r'[^a-z0-9]+', '_', origin.lower()).strip('_')
        if not label or label in used:
            raise ValueError('Conflicting license name: ' + str(file))
        used.add(label)
        shutil.copyfile(file, licenses / ('LICENSE.' + label + '.txt'))
    if info.get('dependencySources'):
        (licenses / 'FFMPEG_SOURCES.txt').write_text(
            'Matching dependency source and build materials: ' +
            info['dependencySources'].get('url', info['dependencySources']['filename']) + '\n',
            encoding='utf-8')
